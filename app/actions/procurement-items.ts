'use server';

/**
 * Procurement Item(采购核料项)—— P1′。
 * 同订单内按 物料身份+颜色+单位 自动归并 material_requirements → 采购确认 → 生命周期。
 * Constitution 02(需求量 live 引用不复制)/ 03(生命周期)/ 04(本表=采购层)。
 * 红线:不改 O1/O2/B1/material_requirements/procurement_line_items/现有采购中心;只读 join 引用上游;不接 AI。
 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { friendlyError } from '@/lib/utils/db-error';
import { hasRoleInGroup } from '@/lib/domain/roles';
import { consolidationKey, computeSuggestedPurchaseQty, type IdentityInput } from '@/lib/services/procurement-consolidation';
import {
  buildExecutionLineRow, canGenerateExecution, resolveReceivingStatus, resolveOrderedStatus, deriveFulfillment, orderableQty, distributeBySize, distributeByWeights, shouldSplitBySize,
} from '@/lib/services/procurement-execution';
import { getOrderLeftover } from '@/app/actions/inventory';

const num = (v: any) => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));

/** 列出某订单的采购核料项。底价按角色 server 端剥离(红线③:业务/生产只见建议价)。 */
export async function listProcurementItems(orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  // 底价可见性:非采购/财务/管理员 → 剥离 unit_price/金额/历史成交价(server 端剥,非 UI 隐藏)
  const { data: prof } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (prof as any)?.roles?.length > 0 ? (prof as any).roles : [(prof as any)?.role].filter(Boolean);
  const canSeeFloor = hasRoleInGroup(roles, 'CAN_SEE_PROCUREMENT_FLOOR');
  const { data, error } = await (supabase.from('procurement_items') as any)
    .select('*').eq('order_id', orderId).order('item_no');
  if (error) return { error: friendlyError(error) };
  // 录入留痕:创建/确认/补采购申请/财务审批 → 姓名(一次查全,失败不阻断)
  try {
    const uids = [...new Set((data || []).flatMap((r: any) =>
      [r.created_by, r.confirmed_by, r.supplement_requested_by, r.finance_approved_by]).filter(Boolean))];
    if (uids.length > 0) {
      const { data: profs } = await (supabase.from('profiles') as any).select('user_id, name').in('user_id', uids);
      const nameMap = new Map<string, string>((profs || []).map((p: any) => [p.user_id, p.name]));
      const nm = (uid: any) => (uid ? nameMap.get(uid) || null : null);
      for (const r of (data || [])) {
        (r as any).created_by_name = nm(r.created_by);
        (r as any).confirmed_by_name = nm(r.confirmed_by);
        (r as any).supplement_requested_by_name = nm(r.supplement_requested_by);
        (r as any).finance_approved_by_name = nm(r.finance_approved_by);
      }
    }
  } catch { /* 姓名解析失败不影响列表 */ }

  // 供应商记忆(2026-07-03 确认归并加强 ①):同一物料上次从谁家买的、什么价 → 建议
  // 身份口径:有主数据码按码配,没有按 名称+规格(不含颜色——供应商供的是料,不分色)
  try {
    const masterIds = [...new Set((data || []).map((r: any) => r.material_master_id).filter(Boolean))];
    const names = [...new Set((data || []).map((r: any) => r.material_name).filter(Boolean))];
    if (masterIds.length > 0 || names.length > 0) {
      let hq = (supabase.from('procurement_items') as any)
        .select('material_master_id, material_name, specification, confirmed_supplier_name, unit_price, currency, confirmed_at, orders(order_no)')
        .neq('order_id', orderId)
        .not('confirmed_supplier_name', 'is', null)
        .order('confirmed_at', { ascending: false })
        .limit(120);
      const ors: string[] = [];
      if (masterIds.length) ors.push(`material_master_id.in.(${masterIds.join(',')})`);
      if (names.length) ors.push(`material_name.in.(${names.map(n => `"${String(n).replace(/"/g, '')}"`).join(',')})`);
      hq = hq.or(ors.join(','));
      const { data: hist } = await hq;
      const norm = (s: any) => String(s ?? '').trim().toLowerCase();
      const byMaster = new Map<string, any>();
      const byNameSpec = new Map<string, any>();
      for (const h of (hist || [])) {                       // 已按时间倒序,首个=最近
        const rec = {
          supplier: h.confirmed_supplier_name, unit_price: h.unit_price, currency: h.currency,
          confirmed_at: h.confirmed_at, order_no: h.orders?.order_no || null,
        };
        if (h.material_master_id && !byMaster.has(h.material_master_id)) byMaster.set(h.material_master_id, rec);
        const k = `${norm(h.material_name)}|${norm(h.specification)}`;
        if (!byNameSpec.has(k)) byNameSpec.set(k, rec);
      }
      for (const r of (data || [])) {
        (r as any).last_purchase =
          (r.material_master_id && byMaster.get(r.material_master_id)) ||
          byNameSpec.get(`${norm(r.material_name)}|${norm(r.specification)}`) || null;
      }
    }
  } catch { /* 历史建议失败不影响列表 */ }

  // 预算对照(2026-07-08 弃用报价基线):预算单价来自 materials_bom.budget_unit_price(业务在采购核料填)。
  // 采购实际单价 > 预算单价(容差0)→ 超预算,需财务审批。单耗不再对照(大货单耗已是唯一真相,无报价单耗可比)。
  // 在剥价前算(用 unit_price 比对),剥价时同步剥预算价字段。
  try {
    const { data: bomRows } = await (supabase.from('materials_bom') as any)
      .select('material_name, color, style_no, budget_unit_price').eq('order_id', orderId);
    const budgetLines = ((bomRows || []) as any[])
      .filter((b) => Number(b.budget_unit_price) > 0)
      .map((b) => ({ style_no: b.style_no, material_name: b.material_name, color: b.color, quote_consumption: null, quote_unit_price: Number(b.budget_unit_price) }));
    if (budgetLines.length > 0) {
      const { matchBaseline, checkOverBaseline } = await import('@/lib/domain/cost-baseline');
      for (const r of (data || [])) {
        const base = matchBaseline(budgetLines, (r as any).material_name, (r as any).color, (r as any).style_no);
        (r as any).baseline = base.matched ? checkOverBaseline(base, null, (r as any).unit_price ?? null) : null;
      }
    }
  } catch { /* 预算对照失败不影响列表 */ }

  // 底价剥离(红线③):非可见底价角色 → 删 unit_price/金额/历史成交价,server 端剥离
  if (!canSeeFloor) {
    for (const r of (data || [])) {
      delete (r as any).unit_price;
      delete (r as any).ordered_amount;
      delete (r as any).difference_amount;
      if ((r as any).last_purchase) delete (r as any).last_purchase.unit_price;
      // 报价基线的价维也剥离(报价单价=成本),只留单耗对照
      if ((r as any).baseline) { delete (r as any).baseline.quote_unit_price; delete (r as any).baseline.price_over_pct; delete (r as any).baseline.over_price; }
    }
  }

  return { data: data || [], canSeeFloor };
}

/**
 * 核料归并:读 material_requirements ⋈ snapshot_lines ⋈ materials_bom → 按 key 分组 → upsert 采购项。
 * 分步查询 + JS join(避开深层 PostgREST 嵌套 join 脆弱)。保留采购已填决策,仅刷新系统字段。
 */
/**
 * 库存抵扣(2026-07-03 用户拍板:减尾料 + 进采购单标库存 + 不采购)。
 * 用现有尾料库存抵扣某采购项:预留锁定该量(别的单不能再用)→ 记 stock_deduct_qty →
 * 最终采购量减去它(只向供应商买剩余;全抵扣则采购量=0,不生成执行行)。发货时领用核销。
 */
export async function deductFromStock(itemId: string, orderId: string): Promise<{
  deducted?: number; remaining?: number; total_deduct?: number; error?: string;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const roleErr = await requireProcurementRole(supabase, user.id);
  if (roleErr) return { error: roleErr };

  const { data: it, error: gErr } = await (supabase.from('procurement_items') as any)
    .select('id, order_id, consolidation_key, material_master_id, material_name, unit, total_required_qty, suggested_purchase_qty, final_purchase_qty, stock_deduct_qty, procurement_notes')
    .eq('id', itemId).single();
  if (gErr || !it) return { error: gErr?.message || '采购项不存在' };
  if ((it as any).order_id !== orderId) return { error: '采购项与订单不匹配' };

  // 当前还要采购的量(最终采购量;未设则建议;再未设则总需求)
  const base = Number((it as any).final_purchase_qty ?? (it as any).suggested_purchase_qty ?? (it as any).total_required_qty) || 0;
  if (base <= 0) return { error: '当前采购量为 0,无需抵扣' };

  const { getAvailableStockByKeys, reserveStock } = await import('@/app/actions/inventory');
  const av = await getAvailableStockByKeys([(it as any).consolidation_key]);
  const available = (av as any).data?.[(it as any).consolidation_key]?.available || 0;
  if (available <= 0) return { error: '该物料当前无可用库存尾料,无需抵扣(可先做「尾料清点归库」)' };

  const deduct = Math.round(Math.min(available, base) * 1000) / 1000;

  // 预留锁定(逻辑锁,别的单不能再抵这批;发货时 consumeReservation/领料核销)
  const rv = await reserveStock({
    materialKey: (it as any).consolidation_key,
    materialMasterId: (it as any).material_master_id || null,
    orderId, procurementItemId: itemId, qty: deduct,
    source: 'procurement', note: `库存抵扣:${(it as any).material_name || ''} ${deduct}${(it as any).unit || ''}(不采购,发货领用核销)`,
  });
  if ((rv as any).error) return { error: '预留库存失败:' + (rv as any).error };

  // 2026-07-04 审计修 P1-4:只累加 stock_deduct_qty,不动 final_purchase_qty。
  // 出单量派生 = 定案量 − 抵扣量(orderableQty),避免 final 一字段扛两义、改参数抹掉抵扣→重复采购。
  const totalDeduct = Math.round(((Number((it as any).stock_deduct_qty) || 0) + deduct) * 1000) / 1000;
  const remaining = orderableQty({ final_purchase_qty: (it as any).final_purchase_qty, suggested_purchase_qty: (it as any).suggested_purchase_qty, stock_deduct_qty: totalDeduct });
  const stamp = `[库存抵扣 ${deduct}${(it as any).unit || ''}:用尾料库存,已预留锁定,不采购,发货领用核销]`;
  const upd: any = {
    stock_deduct_qty: totalDeduct,
    procurement_notes: (it as any).procurement_notes ? `${(it as any).procurement_notes} ${stamp}` : stamp,
    updated_at: new Date().toISOString(),
  };
  const { error: uErr } = await (supabase.from('procurement_items') as any).update(upd).eq('id', itemId);
  if (uErr) return { error: friendlyError(uErr) };

  // 审计修(2026-07-04):抵扣后同步【未下单且未归采购单】执行行的 ordered_qty = 抵扣后出单量,
  // 否则执行行仍是抵扣前全量 → 归单/导出/下单发给供应商的量把已抵扣的库存重复采购。
  // 已归采购单的行(purchase_order_id 非空)不静默改,标 needs_reconfirm 让采购走补/退。
  try {
    await (supabase.from('procurement_line_items') as any)
      .update({ ordered_qty: remaining, updated_at: new Date().toISOString() })
      .eq('procurement_item_id', itemId)
      .in('line_status', ['draft', 'pending_order'])
      .is('purchase_order_id', null);
    const { count: placedCount } = await (supabase.from('procurement_line_items') as any)
      .select('id', { count: 'exact', head: true })
      .eq('procurement_item_id', itemId).not('purchase_order_id', 'is', null);
    if ((placedCount || 0) > 0) {
      await (supabase.from('procurement_items') as any).update({ needs_reconfirm: true }).eq('id', itemId);
    }
  } catch (e: any) { console.warn('[deductFromStock] 执行行数量同步失败(不阻断):', e?.message); }

  revalidatePath(`/orders/${orderId}`);
  return { deducted: deduct, remaining, total_deduct: totalDeduct };
}

/**
 * 采购下单节点自动完成(2026-07-03:下了采购单,「待采购订单」卡就该消失)。
 * 条件:该订单有采购项 且 全部已下单(ordered 及之后)→ 自动完成
 * procurement_order_placed 节点(系统内采购单即证据;留痕+触发置信度重算)。
 * 幂等:节点不存在/已完成静默跳过。触发点:采购单下单钩子 + 采购中心队列自愈。
 */
export async function autoCompleteProcurementPlacedForOrder(supabase: any, orderId: string, poNo?: string | null): Promise<boolean> {
  const ORDERED = ['ordered', 'partially_received', 'completed', 'closed'];
  const { data: items } = await (supabase.from('procurement_items') as any)
    .select('status').eq('order_id', orderId);
  if (!items || items.length === 0) return false;
  if (!items.every((i: any) => ORDERED.includes(i.status))) return false;

  const { data: ms } = await (supabase.from('milestones') as any)
    .select('id, status').eq('order_id', orderId).eq('step_key', 'procurement_order_placed').maybeSingle();
  if (!ms) return false;
  const st = String((ms as any).status || '').toLowerCase();
  if (st === 'done' || st === '已完成') return false;

  const now = new Date().toISOString();
  const { error } = await (supabase.from('milestones') as any)
    .update({ status: 'done', completed_at: now, actual_at: now, updated_at: now }).eq('id', (ms as any).id);
  if (error) return false;
  await (supabase.from('milestone_logs') as any).insert({
    milestone_id: (ms as any).id,
    order_id: orderId,
    action: 'status_transition',
    note: `全部采购项已下单${poNo ? `(${poNo})` : ''} → 系统自动完成「采购下单」节点(系统内采购单即证据)`,
    payload: { auto: true, source: 'purchase_order.placed', po_no: poNo || null },
  }).then(() => {}, () => {});
  void (async () => {
    try {
      const { recomputeDeliveryConfidence } = await import('@/app/actions/runtime-confidence');
      await recomputeDeliveryConfidence(orderId, {
        type: 'milestone_status_changed',
        source: `milestone:${(ms as any).id}`,
        severity: 'info',
        payload: { milestone_id: (ms as any).id, new_status: 'done', auto: 'procurement_order_placed' },
      });
    } catch { /* 忽略 */ }
  })();
  return true;
}

/** 下单钩子:该采购单涉及的订单逐一尝试自动完成「采购下单」节点(fire-and-forget)。
 *  P0 复审修:可传入 client(placeCore 在财务回调 webhook 上下文里无 cookie 会话,须用传入的 service-role)。 */
export async function autoCompleteProcurementPlacedForPO(poId: string, client?: any) {
  const supabase = client || await createClient();
  if (!client) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
  }
  const { data: po } = await (supabase.from('purchase_orders') as any)
    .select('po_no').eq('id', poId).maybeSingle();
  const { data: lines } = await (supabase.from('procurement_line_items') as any)
    .select('order_id').eq('purchase_order_id', poId);
  const orderIds = [...new Set((lines || []).map((l: any) => l.order_id).filter(Boolean))];
  for (const oid of orderIds) {
    try { await autoCompleteProcurementPlacedForOrder(supabase, oid as string, (po as any)?.po_no); } catch { /* 单个失败不阻断 */ }
  }
}

/**
 * 按款核定大货单耗(2026-07-03 用户拍板:不填好每个单款的大货单耗,不许归并)。
 * 列出该订单 BOM 的用料行(布料必核;辅料/包装可选核),含开发单耗对照。
 */
export async function listBomConsumptionLines(orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data, error } = await (supabase.from('materials_bom') as any)
    .select('*').eq('order_id', orderId).order('style_no').order('color');
  if (error) return { error: friendlyError(error) };

  // 预算单耗:从报价基线(内部报价单冻结、人已确认)带过来,给采购核定时对照(2026-07-06 用户)。
  // 按 款号+物料 精确匹配,配不上退回 物料名 匹配。
  const { data: cb } = await (supabase.from('order_cost_baseline') as any)
    .select('quote_baseline_lines').eq('order_id', orderId).maybeSingle();
  const baseLines: any[] = (cb as any)?.quote_baseline_lines || [];
  const norm = (s: any) => String(s ?? '').trim().toLowerCase();
  const byStyleMat = new Map<string, { cons: number | null; price: number | null }>();
  const byMat = new Map<string, { cons: number | null; price: number | null }>();
  for (const bl of baseLines) {
    const c = Number(bl.quote_consumption) || null;
    const p = Number(bl.quote_unit_price) || null;
    if (!c && !p) continue;
    const mat = norm(bl.material_name);
    if (bl.style_no) byStyleMat.set(`${norm(bl.style_no)}¦${mat}`, { cons: c, price: p });
    if (!byMat.has(mat)) byMat.set(mat, { cons: c, price: p });
  }
  const quoteOf = (b: any): { cons: number | null; price: number | null } => {
    const mat = norm(b.material_name);
    if (b.style_no) { const v = byStyleMat.get(`${norm(b.style_no)}¦${mat}`); if (v) return v; }
    return byMat.get(mat) ?? { cons: null, price: null };
  };

  // 数量(件数,#1 用户):按 款×色 从 order_line_items 取;整单通用辅料行(无款号)→ 订单总数
  const { data: ord } = await (supabase.from('orders') as any).select('quantity').eq('id', orderId).maybeSingle();
  const orderQty = Number((ord as any)?.quantity) || 0;
  const { data: lis } = await (supabase.from('order_line_items') as any)
    .select('style_no, color_cn, color_en, qty_pcs').eq('order_id', orderId);
  const byStyle = new Map<string, number>();
  const byStyleColor = new Map<string, number>();
  for (const li of (lis || [])) {
    const q = Number((li as any).qty_pcs) || 0;
    const st = norm((li as any).style_no);
    byStyle.set(st, (byStyle.get(st) || 0) + q);
    // 累加(原用 = 覆盖:同款×色多行(客户加单)只显示最后一行量,预览失真)
    for (const col of [(li as any).color_cn, (li as any).color_en]) if (col) { const k = `${st}¦${norm(col)}`; byStyleColor.set(k, (byStyleColor.get(k) || 0) + q); }
  }
  const pieceOf = (b: any): number | null => {
    // 辅料业务手填了总需用量 → 数量列直接显示它(中包袋按业务填的 1250,不是件数 7500)
    const isTrim = b.material_type !== 'fabric' && b.material_type !== 'lining';
    if (isTrim && Number(b.total_qty) > 0) return Number(b.total_qty);
    const st = norm(b.style_no);
    if (b.style_no && b.color) { const v = byStyleColor.get(`${st}¦${norm(b.color)}`); if (v != null) return v; }
    if (b.style_no) { const v = byStyle.get(st); if (v) return v; }
    return orderQty || null;   // 整单通用(无款号)行 → 订单总数
  };

  const rows = (data || []).map((b: any) => ({
    id: b.id,
    style_no: b.style_no || null,
    color: b.color || null,
    pieces: pieceOf(b),                                        // 数量(件数,#1):供采购核料看单
    material_name: b.material_name || null,
    material_type: b.material_type || null,
    spec: b.spec || null,
    unit: b.unit || null,
    development_consumption: b.qty_per_piece ?? null,          // 开发单耗(业务,只读)
    // 预算单价:业务在采购核料填(存 materials_bom.budget_unit_price);老单退回报价基线(将弃用)
    budget_unit_price: b.budget_unit_price ?? quoteOf(b).price ?? null,
    // 预算单耗 = 大货单耗(采购真实口径);老单退回报价单耗。面料预算=预算单耗×预算单价×件数
    budget_consumption: b.production_consumption ?? quoteOf(b).cons ?? null,
    production_consumption: b.production_consumption ?? null,  // 大货单耗(业务/技术填,采购核实)
    over_purchase_pct: b.over_purchase_pct ?? null,            // 抛量%(采购填)
    required: b.material_type === 'fabric' || b.material_type === 'lining',  // 布料必核
    // 供料方式:self=绮陌自购 / customer=客供 / factory=加工厂承担。后两者绮陌都不采购、不计成本。
    supply_mode: b.factory_supplied === true ? 'factory' : (b.customer_supplied === true ? 'customer' : 'self'),
  }));
  return { data: rows };
}

/**
 * 保存物料「供料方式」(三选一):self=绮陌自购 / customer=客供 / factory=加工厂承担。批量 {bom_id: mode}。
 * customer/factory 两者绮陌都【不采购、不计成本】(归并跳过 + 财务面料成本不计),仅保留规格用量给生产;
 * 区别只在生产任务单辅料明细的标注(客供 / 加工厂承担,后者供财务监督加工厂付款)。互斥:两布尔最多一个 true。
 * 业务/理单/采购/管理员可改。存 materials_bom.customer_supplied + factory_supplied。
 */
export async function saveBomSupplyMode(orderId: string, entries: Record<string, 'self' | 'customer' | 'factory'>) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data: prof } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const uRoles: string[] = (prof as any)?.roles?.length ? (prof as any).roles : [(prof as any)?.role].filter(Boolean);
  if (!uRoles.some((r) => ['sales', 'merchandiser', 'sales_manager', 'order_manager', 'procurement', 'procurement_manager', 'admin'].includes(r))) {
    return { error: '仅业务/理单/采购/管理员可改供料方式' };
  }
  let saved = 0;
  for (const [bomId, mode] of Object.entries(entries || {})) {
    const { error } = await (supabase.from('materials_bom') as any)
      .update({ customer_supplied: mode === 'customer', factory_supplied: mode === 'factory' })
      .eq('id', bomId).eq('order_id', orderId);
    if (error) {
      if (/factory_supplied|column .* does not exist/i.test(error.message || '')) {
        return { error: '加工厂承担列尚未建立:请先在 Supabase 执行 20260711_bom_factory_supplied.sql' };
      }
      if (/customer_supplied/i.test(error.message || '')) {
        return { error: '客供列尚未建立:请先在 Supabase 执行 20260710_bom_customer_supplied.sql' };
      }
      return { error: friendlyError(error) };
    }
    saved++;
  }
  // 供料方式变动 → 重算财务成本兜底缓存(客供/加工厂承担 面料不计入面料预算)
  try { const { recomputeOrderBudgetCaches } = await import('@/app/actions/quote-baseline'); await recomputeOrderBudgetCaches(orderId); } catch { /* 不阻断 */ }
  revalidatePath(`/orders/${orderId}`);
  return { ok: true, saved };
}

/** 保存按款大货单耗(2026-07-06 用户拍板:改为业务执行填,技术部大货版;业务/理单/采购/管理员均可)。批量 {bom_id: 值}。 */
export async function saveBomProductionConsumption(orderId: string, entries: Record<string, number | null>) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data: prof } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const uRoles: string[] = (prof as any)?.roles?.length ? (prof as any).roles : [(prof as any)?.role].filter(Boolean);
  if (!uRoles.some((r) => ['sales', 'merchandiser', 'sales_manager', 'order_manager', 'procurement', 'procurement_manager', 'admin'].includes(r))) {
    return { error: '仅业务/理单/采购/管理员可填大货单耗' };
  }

  let saved = 0;
  for (const [bomId, val] of Object.entries(entries || {})) {
    const v = val === null || val === undefined || isNaN(Number(val)) || Number(val) <= 0 ? null : Number(val);
    const { error } = await (supabase.from('materials_bom') as any)
      .update({ production_consumption: v }).eq('id', bomId).eq('order_id', orderId);
    if (error) {
      if (/production_consumption|column .* does not exist/i.test(error.message || '')) {
        return { error: '大货单耗列尚未建立:请先在 Supabase 执行 20260703_per_style_production_consumption.sql' };
      }
      return { error: friendlyError(error) };
    }
    saved++;
  }
  revalidatePath(`/orders/${orderId}`);
  return { ok: true, saved };
}

/** 保存逐料抛量%(2026-07-06 用户拍板:采购职权;批量 {bom_id: %})。采购量=件数×大货单耗×(1+抛量%)。 */
export async function saveBomOverPurchasePct(orderId: string, entries: Record<string, number | null>) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const roleErr = await requireProcurementRole(supabase, user.id);
  if (roleErr) return { error: roleErr };   // 抛量是采购职权
  let saved = 0;
  for (const [bomId, val] of Object.entries(entries || {})) {
    const v = val === null || val === undefined || isNaN(Number(val)) || Number(val) < 0 ? 0 : Number(val);
    const { error } = await (supabase.from('materials_bom') as any)
      .update({ over_purchase_pct: v }).eq('id', bomId).eq('order_id', orderId);
    if (error) {
      if (/over_purchase_pct|column .* does not exist/i.test(error.message || '')) {
        return { error: '抛量列尚未建立:请先在 Supabase 执行 20260706_bom_over_purchase_pct.sql' };
      }
      return { error: friendlyError(error) };
    }
    saved++;
  }
  revalidatePath(`/orders/${orderId}`);
  return { ok: true, saved };
}

/** 保存面料预算单价(2026-07-08 用户拍板:预算改在采购核料按真实物料填,取代报价单识别)。批量 {bom_id: 单价}。 */
export async function saveBomBudgetUnitPrice(orderId: string, entries: Record<string, number | null>) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data: prof } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const uRoles: string[] = (prof as any)?.roles?.length ? (prof as any).roles : [(prof as any)?.role].filter(Boolean);
  if (!uRoles.some((r) => ['sales', 'merchandiser', 'sales_manager', 'order_manager', 'procurement', 'procurement_manager', 'admin'].includes(r))) {
    return { error: '仅业务/理单/采购/管理员可填预算单价' };
  }
  let saved = 0;
  for (const [bomId, val] of Object.entries(entries || {})) {
    const v = val === null || val === undefined || isNaN(Number(val)) || Number(val) <= 0 ? null : Number(val);
    const { error } = await (supabase.from('materials_bom') as any)
      .update({ budget_unit_price: v }).eq('id', bomId).eq('order_id', orderId);
    if (error) {
      if (/budget_unit_price|column .* does not exist/i.test(error.message || '')) {
        return { error: '预算单价列尚未建立:请先在 Supabase 执行 20260708_bom_budget_unit_price.sql' };
      }
      return { error: friendlyError(error) };
    }
    saved++;
  }
  // 预算变动 → 重算财务成本兜底缓存(budget_fabric_amount 等)
  try { const { recomputeOrderBudgetCaches } = await import('@/app/actions/quote-baseline'); await recomputeOrderBudgetCaches(orderId); } catch { /* 不阻断 */ }
  revalidatePath(`/orders/${orderId}`);
  return { ok: true, saved };
}

// 可看/可填预算(加工费/辅料)的角色 —— 业务/理单/采购/财务/管理员。
// order_cost_baseline 的 RLS 只放行 订单 owner/创建人/canSeeAll;非订单负责人的业务执行(merchandiser)、
// 采购(procurement)会被 RLS 挡成空白(2026-07-10 实测:cathy/pin can_access_baseline=false),
// 表现为「款号行在、加工费/辅料一口价空」。授权改由此角色门把关,DB 读写走 service-role,与 quote-baseline 一致。
const BUDGET_ROLES = [
  'sales', 'merchandiser', 'sales_manager', 'order_manager',
  'procurement', 'procurement_manager', 'finance', 'admin',
  'admin_assistant', 'production_manager',
];

/** 逐款预算(加工费,元/件)+ 整单辅料总价一口价:读。存 order_cost_baseline。业务在采购核料填。 */
export async function getOrderStyleBudgets(orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  // 角色门:授权由此把关(取代过严的 order_cost_baseline SELECT RLS),再用 service-role 读回预算
  const { data: prof } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const uRoles: string[] = (prof as any)?.roles?.length ? (prof as any).roles : [(prof as any)?.role].filter(Boolean);
  if (!uRoles.some((r) => BUDGET_ROLES.includes(r))) return { error: '无权查看预算' };
  const svc = createServiceRoleClient();
  const { data: cb, error: cbErr } = await (svc.from('order_cost_baseline') as any)
    .select('*').eq('order_id', orderId).maybeSingle();   // select * → accessory_budget_total 列未建也不报错
  if (cbErr) return { error: friendlyError(cbErr) };
  const existing: any[] = (cb as any)?.quote_style_budgets || [];
  // 款号来自 order_line_items(逐款明细),预填每款一行;已存的加工费带回
  const { data: lis } = await (svc.from('order_line_items') as any).select('style_no').eq('order_id', orderId);
  const norm = (s: any) => String(s ?? '').trim();
  const styles = [...new Set((lis || []).map((l: any) => norm(l.style_no)).filter(Boolean))];
  const byStyle = new Map(existing.map((b: any) => [norm(b.style_no), b]));
  const rows = (styles.length ? styles : existing.map((b: any) => norm(b.style_no))).map((st: string) => {
    const b = byStyle.get(st) || {};
    return { style_no: st, cmt: (b as any).cmt ?? null };
  });
  const accessoryTotal = (cb as any)?.accessory_budget_total ?? null;   // 整单辅料一口价
  return { data: rows, accessoryTotal };
}

/** 逐款加工费(cmt,元/件)+ 整单辅料总价(一口价)保存。业务/采购/管理员可填。 */
export async function saveOrderStyleBudgets(
  orderId: string,
  budgets: Array<{ style_no: string; cmt: number | null }>,
  accessoryTotal?: number | null,
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data: prof } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const uRoles: string[] = (prof as any)?.roles?.length ? (prof as any).roles : [(prof as any)?.role].filter(Boolean);
  if (!uRoles.some((r) => BUDGET_ROLES.includes(r))) {
    return { error: '仅业务/理单/采购/财务/管理员可填加工费/辅料预算' };
  }
  const num = (v: any) => { const n = Number(v); return isFinite(n) && n > 0 ? n : null; };
  // 逐款只存加工费 cmt;辅料改整单一口价(清掉历史逐款 trim_budget,避免和一口价重复计)
  const clean = (budgets || []).filter((b) => String(b.style_no || '').trim())
    .map((b) => ({ style_no: String(b.style_no).trim(), cmt: num(b.cmt), trim_budget: null }));
  const accTotal = accessoryTotal === undefined ? undefined : num(accessoryTotal);
  // 写走 service-role:order_cost_baseline 的 INSERT/UPDATE RLS 只放行 owner/canSeeAll,
  // 非订单负责人的业务/采购用 user session 写会静默 0 行(RLS)—— 授权已由上面角色门把关。
  const svc = createServiceRoleClient();
  const { data: existing } = await (svc.from('order_cost_baseline') as any).select('id').eq('order_id', orderId).maybeSingle();
  const basePayload: Record<string, any> = { quote_style_budgets: clean, updated_at: new Date().toISOString() };
  const withAcc = accTotal === undefined ? basePayload : { ...basePayload, accessory_budget_total: accTotal };
  let accColMissing = false;
  const run = async (payload: Record<string, any>) => existing
    ? (svc.from('order_cost_baseline') as any).update(payload).eq('order_id', orderId).select('id')
    : (svc.from('order_cost_baseline') as any).insert({ order_id: orderId, ...payload }).select('id');
  let { data: wrote, error } = await run(withAcc);
  if (error && /accessory_budget_total|column .* does not exist/i.test(error.message || '')) {
    // 迁移未跑:降级只存加工费(不 brick),辅料总价待迁移后再存
    accColMissing = true;
    ({ data: wrote, error } = await run(basePayload));
  }
  if (error) return { error: friendlyError(error) };
  if (!wrote || (wrote as any[]).length === 0) return { error: '预算未写入(0 行受影响),请重试或联系管理员' };
  try { const { recomputeOrderBudgetCaches } = await import('@/app/actions/quote-baseline'); await recomputeOrderBudgetCaches(orderId); } catch { /* 不阻断 */ }
  if (accColMissing) return { ok: true, warning: '辅料总价列尚未建立:请先在 Supabase 执行 20260708_order_accessory_budget_total.sql(加工费已保存)' } as any;
  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}

/**
 * 核料归并 —— 两步制(2026-07-03 用户拍板:不许一键直写):
 *  dryRun:true → 只算不写,返回变更计划(新增/改数/参数同步/孤儿清理,逐项旧→新);
 *  执行 → 按 apply 勾选项落库(create=建新项 refresh=刷新数量参数 cleanup=清孤儿)。
 */
export async function consolidateOrderProcurementItems(
  orderId: string,
  opts: { dryRun?: boolean; apply?: { create?: boolean; refresh?: boolean; cleanup?: boolean } } = {},
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  // 归并会 写/删 采购项 + 触发财务通知 → 写路径必须采购/管理员(dryRun 只算不写,放宽给能看的角色)
  if (!opts.dryRun) {
    const roleErr = await requireProcurementRole(supabase, user.id);
    if (roleErr) return { error: roleErr };
  }

  const { data: order } = await (supabase.from('orders') as any).select('order_no').eq('id', orderId).single();
  const orderNo = (order as any)?.order_no || orderId.slice(0, 8);

  // 补采购判定(品类补):订单已过「采购下单」节点后核料出的【新】采购项 = 漏采补录
  // → 自动标补采购 + 待财务审批(存量项/未下单前的核料完全不受影响)。
  let afterProcurementPlaced = false;
  {
    const { data: poMs } = await (supabase.from('milestones') as any)
      .select('status').eq('order_id', orderId).eq('step_key', 'procurement_order_placed').maybeSingle();
    const st = String((poMs as any)?.status || '').toLowerCase();
    afterProcurementPlaced = st === 'done' || st === '已完成';
  }

  // 采购人工合并映射(同物料不同单位/键 的两条 → 归一):归并键计算后按此重映射,使合并永久生效。
  const mergeMap = new Map<string, string>();
  {
    const { data: cbM } = await (supabase.from('order_cost_baseline') as any)
      .select('consolidation_merges').eq('order_id', orderId).maybeSingle();
    for (const m of (((cbM as any)?.consolidation_merges) || [])) {
      if (m?.from && m?.to) mergeMap.set(String(m.from), String(m.to));
    }
  }

  // 1) 需求(pieces_qty=件数基数;迁移前老行为空,按 net/dev 反推兜底)
  const { data: reqs, error: rErr } = await (supabase.from('material_requirements') as any)
    .select('*').eq('order_id', orderId);
  if (rErr) return { error: friendlyError(rErr) };
  if (!reqs || reqs.length === 0) return { error: '该订单暂无物料需求(请先在「原辅料和包装」提交采购,跑出 MRP)' };

  // 2) snapshot_lines(color/spec/开发单耗/bom_id)
  const slIds = Array.from(new Set(reqs.map((r: any) => r.snapshot_line_id).filter(Boolean)));
  const slMap = new Map<string, any>();
  if (slIds.length) {
    const { data: sls } = await (supabase.from('material_package_snapshot_lines') as any)
      .select('id, color, specification, qty_per_piece, bom_id, material_name, loss_rate').in('id', slIds);
    for (const s of (sls || [])) slMap.set(s.id, s);
  }
  // 3) materials_bom（master_id + 色卡图 + 按款核定的大货单耗,select * 抗迁移未跑）
  const bomIds = Array.from(new Set([...slMap.values()].map((s: any) => s.bom_id).filter(Boolean)));
  const bomMaster = new Map<string, string | null>();
  const bomImages = new Map<string, string[]>();
  const bomAttach = new Map<string, Array<{ name: string; url: string }>>();   // 辅料排版稿/文件附件
  const bomExtra = new Map<string, { prod: number | null; style_no: string | null; overPct: number; notSelfSupplied: boolean }>();
  if (bomIds.length) {
    const { data: bs } = await (supabase.from('materials_bom') as any).select('*').in('id', bomIds);
    for (const b of (bs || [])) {
      bomMaster.set(b.id, b.material_master_id);
      if (Array.isArray(b.image_urls) && b.image_urls.length) bomImages.set(b.id, b.image_urls);
      if (Array.isArray(b.attachment_files) && b.attachment_files.length) bomAttach.set(b.id, b.attachment_files);
      bomExtra.set(b.id, {
        prod: b.production_consumption != null && Number(b.production_consumption) > 0 ? Number(b.production_consumption) : null,
        style_no: b.style_no || null,
        overPct: Number(b.over_purchase_pct) > 0 ? Number(b.over_purchase_pct) : 0,   // 抛量%(采购填)
        notSelfSupplied: b.customer_supplied === true || b.factory_supplied === true,   // 客供/加工厂承担:绮陌都不采购
      });
    }
  }

  // 4) 按 key 分组 —— 逐行精确算(2026-07-03 用户拍板:废除代表单耗/平均,
  //    每行 = 该款件数 × 该款大货单耗;布料未核定大货单耗 → 不许归并)
  const groups = new Map<string, any>();
  const missingProd: Array<{ style_no: string | null; color: string | null; material_name: string | null }> = [];
  for (const r of reqs) {
    const sl = r.snapshot_line_id ? slMap.get(r.snapshot_line_id) : null;
    const master_id = sl?.bom_id ? (bomMaster.get(sl.bom_id) || null) : null;
    const identity: IdentityInput = {
      material_master_id: master_id,
      material_name: r.material_name || sl?.material_name || null,
      specification: sl?.specification || null,
      category: r.category || null,
      color: sl?.color || null,
      unit: r.unit || null,
    };
    const rawKey = consolidationKey(identity);
    const key = mergeMap.get(rawKey) || rawKey;   // 人工合并:源键 → 目标键(两条同物料并一条)
    const net = Number(r.net_purchase_qty) || 0;
    const dev = sl?.qty_per_piece != null ? Number(sl.qty_per_piece) : null;
    const loss = sl?.loss_rate != null ? Number(sl.loss_rate) : null;
    const extra = sl?.bom_id ? bomExtra.get(sl.bom_id) : null;
    // 客供/加工厂承担:绮陌不采购 → 跳过归并,不进采购项/执行行/应付,也不算缺大货单耗。
    if (extra?.notSelfSupplied) continue;
    // 件数基数:优先需求行存的 pieces_qty;老行(迁移前)按 net/开发单耗 反推(单行反推=精确)
    const pieces = r.pieces_qty != null && Number(r.pieces_qty) > 0
      ? Number(r.pieces_qty)
      : (dev && dev > 0 && net > 0 ? net / dev : null);
    const isFabric = r.category === 'fabric';
    // 行贡献:布料必须用该款核定的大货单耗;辅料/包装核定了用核定,没核定按开发口径
    let lineTotal: number;
    if (isFabric) {
      if (extra?.prod == null) {
        missingProd.push({ style_no: extra?.style_no ?? null, color: sl?.color ?? null, material_name: r.material_name ?? null });
        lineTotal = 0;   // 有缺口整单不落库,此值不会被使用
      } else {
        lineTotal = (pieces ?? 0) * extra.prod;
      }
    } else {
      lineTotal = (extra?.prod != null && pieces != null) ? pieces * extra.prod : net;
    }
    // 2026-07-07 用户拍板:抛量%是【唯一】buffer,只在【采购量=总需求×(1+抛量%)】处算一次。
    //   总需求(g.total)是裸数(件数×大货单耗),不再把抛量乘进总需求 —— 否则和建议采购的损耗叠成双 3%。
    let g = groups.get(key);
    if (!g) { g = { key, ...identity, total: 0, count: 0, devTop: null, devTopNet: -1, lossTop: null, overTop: 0, imgs: [] as string[], attach: [] as Array<{ name: string; url: string }>, reqDate: null, orderBy: null }; groups.set(key, g); }
    g.total += lineTotal; g.count += 1;
    if (net > g.devTopNet) { g.devTopNet = net; g.devTop = dev; g.lossTop = loss; g.overTop = extra?.overPct ?? 0; }   // 主导来源的开发单耗/抛量作代表
    // 汇集来源图(去重,封顶 8 张)
    const imgs = sl?.bom_id ? (bomImages.get(sl.bom_id) || []) : [];
    for (const u of imgs) if (g.imgs.length < 8 && !g.imgs.includes(u)) g.imgs.push(u);
    // 汇集来源排版稿/文件附件(按 url 去重,封顶 12)
    const atts = sl?.bom_id ? (bomAttach.get(sl.bom_id) || []) : [];
    for (const a of atts) if (a?.url && g.attach.length < 12 && !g.attach.some((x: any) => x.url === a.url)) g.attach.push({ name: String(a.name || a.url), url: String(a.url) });
    // 到货倒推:取各来源最早的 需到日/最晚下单日(宁早勿晚)
    if (r.required_date && (!g.reqDate || r.required_date < g.reqDate)) g.reqDate = r.required_date;
    if (r.order_by_date && (!g.orderBy || r.order_by_date < g.orderBy)) g.orderBy = r.order_by_date;
  }
  // 数量取整到 1 位小数(布料 kg 口径;逐行乘完再取整,不再逐行 ceil 叠误差)
  for (const g of groups.values()) g.total = Math.round(g.total * 10) / 10;

  // 布料未核定大货单耗 → 拒绝归并(dryRun 和执行都拦),列出缺口
  if (missingProd.length > 0) {
    const list = missingProd.slice(0, 6).map(m => `${m.style_no || '?'}·${m.color || '无色'}·${m.material_name || ''}`).join(';');
    return {
      error: `不能归并:${missingProd.length} 条布料来源未核定大货单耗(${list}${missingProd.length > 6 ? ' 等' : ''})。请先在「按款核定大货单耗」表格里逐款填写`,
      missingProd,
    };
  }

  // 5) 现有采购项(select * :image_urls 等新列迁移未执行时也不报缺列)
  const { data: existing } = await (supabase.from('procurement_items') as any)
    .select('*').eq('order_id', orderId);
  const exMap = new Map<string, any>((existing || []).map((e: any) => [e.consolidation_key, e]));

  // ── 变更计划(2026-07-03 用户拍板:归并不许一键直写,先让人看到会发生什么)──
  // 孤儿判定(草稿无执行行引用→可删;其余→只标记),计划阶段就算好
  const liveKeys = new Set(groups.keys());
  const orphans = (existing || []).filter((e: any) => !liveKeys.has(e.consolidation_key));
  const orphanDraftIds = orphans.filter((e: any) => e.status === 'draft').map((e: any) => e.id);
  let orphanDeletableIds = new Set<string>(orphanDraftIds);
  if (orphanDraftIds.length > 0) {
    const { data: refd } = await (supabase.from('procurement_line_items') as any)
      .select('procurement_item_id').in('procurement_item_id', orphanDraftIds);
    for (const r of (refd || [])) orphanDeletableIds.delete(r.procurement_item_id);
  }
  const brief = (x: any) => ({ item_no: x.item_no || null, material_name: x.material_name || null, color: x.color || null, unit: x.unit || null, status: x.status || null });
  const plan = {
    creates: [] as any[],        // 新增项(含是否补采购)
    qtyUpdates: [] as any[],     // 总需求变化(旧→新;非草稿会标 needs_reconfirm)
    paramRefresh: 0,             // 数量不变,仅同步参数/图片/日期(安全)
    orphanDelete: orphans.filter((e: any) => orphanDeletableIds.has(e.id)).map(brief),
    orphanFlag: orphans.filter((e: any) => !orphanDeletableIds.has(e.id)).map(brief),
  };
  for (const g of groups.values()) {
    const ex = exMap.get(g.key);
    if (!ex) {
      plan.creates.push({ material_name: g.material_name, color: g.color, unit: g.unit, qty: g.total, is_supplement: afterProcurementPlaced });
    } else if (Number(ex.total_required_qty) !== g.total) {
      plan.qtyUpdates.push({ ...brief(ex), oldQty: ex.total_required_qty, newQty: g.total, willFlag: ex.status !== 'draft' });
    } else {
      plan.paramRefresh++;
    }
  }
  if (opts.dryRun) return { ok: true, plan };

  const apply = { create: true, refresh: true, cleanup: true, ...(opts.apply || {}) };
  let created = 0, updated = 0, flagged = 0, removed = 0, syncedLines = 0;
  let seq = (existing || []).length;
  const now = new Date().toISOString();

  for (const g of groups.values()) {
    const ex = exMap.get(g.key);
    if (ex && !apply.refresh) continue;
    if (!ex && !apply.create) continue;
    if (ex) {
      const devRep = ex.development_consumption ?? g.devTop;
      // 2026-07-07:唯一 buffer = 抛量%(核料对照采购逐料填→over_purchase_pct)。采购量=总需求×(1+抛量%)。
      // procurement_loss_pct 复用为该 buffer 存储位(值=抛量),不再单列采购损耗% → 不再双 3%。
      const buffer = g.overTop;
      const suggested = computeSuggestedPurchaseQty({
        total_required_qty: g.total, development_consumption: devRep,
        production_consumption: ex.production_consumption, procurement_loss_pct: buffer,
        safety_stock_qty: ex.safety_stock_qty, moq: ex.moq,
      });
      const upd: any = {
        total_required_qty: g.total, source_count: g.count, development_consumption: devRep,
        procurement_loss_pct: buffer,
        suggested_purchase_qty: suggested, updated_at: now,
      };
      // 图片合并:来源 BOM 新增的图并进去,采购已补拍的保留(union 去重,封顶 8)
      if (g.imgs.length > 0 && 'image_urls' in (ex as any)) {
        const cur: string[] = Array.isArray((ex as any).image_urls) ? (ex as any).image_urls : [];
        const merged = [...cur];
        for (const u of g.imgs) if (merged.length < 8 && !merged.includes(u)) merged.push(u);
        if (merged.length !== cur.length) upd.image_urls = merged;
      }
      // 排版稿/文件附件合并:来源 BOM 新增的并进去,采购已补的保留(按 url union,封顶 12)
      if (g.attach.length > 0 && 'attachment_files' in (ex as any)) {
        const cur: Array<{ name: string; url: string }> = Array.isArray((ex as any).attachment_files) ? (ex as any).attachment_files : [];
        const merged = [...cur];
        for (const a of g.attach) if (merged.length < 12 && !merged.some((x) => x.url === a.url)) merged.push(a);
        if (merged.length !== cur.length) upd.attachment_files = merged;
      }
      // 到货倒推日期刷新(列存在才写,迁移未跑不报错)。采购手锁了需到日 → 不覆盖(required_date_locked)
      if ('order_by_date' in (ex as any) && !(ex as any).required_date_locked) { upd.required_date = g.reqDate; upd.order_by_date = g.orderBy; }
      const totalChanged = Number(ex.total_required_qty) !== g.total;
      if (totalChanged && ex.status !== 'draft') { upd.needs_reconfirm = true; flagged++; }
      await (supabase.from('procurement_items') as any).update(upd).eq('id', ex.id);
      updated++;
      // 审计修(2026-07-04):重归并抬高/降低需求 → 同步【未下单】执行行的 ordered_qty,
      // 否则执行行停在旧量、静默少采购 + 多表打架。已下单(placed 及以后)的行不动,
      // 靠 needs_reconfirm 提示采购走「补数量申请」——已下单量不能被静默改。
      if (totalChanged) {
        const newOrderable = orderableQty({
          final_purchase_qty: (ex as any).final_purchase_qty,
          suggested_purchase_qty: suggested,
          stock_deduct_qty: (ex as any).stock_deduct_qty,
        });
        try {
          let sync = (supabase.from('procurement_line_items') as any)
            .update({ ordered_qty: newOrderable, updated_at: now })
            .eq('procurement_item_id', ex.id)
            .in('line_status', ['draft', 'pending_order'])
            .is('purchase_order_id', null);   // 已归到采购单的行不动(改量会弄乱 PO 合计)→ 走 needs_reconfirm
          // N1:只同步整量行(size 为空);已按尺码拆的多行不能被同一新量覆盖(否则各码都变总量=超采)→ 让采购重生成执行行
          try { sync = sync.is('size', null); } catch { /* size 列未迁移:忽略,整行覆盖(老口径) */ }
          const { data: syncedRows } = await sync.select('id');
          syncedLines += ((syncedRows || []) as any[]).length;
        } catch (e: any) { console.warn('[consolidate] 执行行数量同步失败(不阻断):', e?.message); }
      }
    } else {
      seq++;
      const suggested = computeSuggestedPurchaseQty({
        total_required_qty: g.total, development_consumption: g.devTop, procurement_loss_pct: g.overTop,
      });
      const row: any = {
        order_id: orderId, consolidation_key: g.key,
        item_no: `PI-${orderNo}-${String(seq).padStart(3, '0')}`,
        material_master_id: g.material_master_id, material_name: g.material_name, specification: g.specification,
        category: g.category, color: g.color, unit: g.unit,
        purchase_unit: g.unit,                // 采购计量单位默认=需求单位(物料录入时选过,买法不同采购再改)
        total_required_qty: g.total, source_count: g.count, development_consumption: g.devTop,
        procurement_loss_pct: g.overTop,      // buffer=抛量%(唯一;总需求裸数,采购量=总需求×(1+抛量%))
        suggested_purchase_qty: suggested, status: 'draft', created_by: user.id,
      };
      if (g.imgs.length > 0) row.image_urls = g.imgs;   // 业务传的色卡/辅料图随归并流转
      if (g.attach.length > 0) row.attachment_files = g.attach;   // 业务传的排版稿/文件附件随归并流转
      if (g.reqDate) row.required_date = g.reqDate;     // 需到日/最晚下单日(到货倒推亮灯)
      if (g.orderBy) row.order_by_date = g.orderBy;
      // 品类补:采购下单后才冒出来的新项 = 漏采补录 → 标补采购,待财务审批
      if (afterProcurementPlaced) {
        row.is_supplement = true;
        row.supplement_reason = '采购下单后核料新增(品类补录)';
        row.supplement_requested_by = user.id;
        row.supplement_requested_at = now;
        row.finance_approval_status = 'pending';
      }
      let { error: iErr } = await (supabase.from('procurement_items') as any).insert(row);
      if (iErr && /column .* does not exist|is_supplement|finance_approval|image_urls|order_by_date|required_date/i.test(iErr.message || '')) {
        // 审计 P0:补采购行若无法写入闸门列(is_supplement/finance_approval_status),
        // 绝不降级为无闸普通项(会绕过财务审批直接确认→下单花钱),直接中止让用户先跑迁移。
        if (row.is_supplement) {
          return { error: '补采购所需数据库列缺失,请先执行 20260703 补采购迁移(supplement/finance_approval)后再核料——绝不降级为无财务审批闸的普通采购项' };
        }
        // 非补采购行:仅图片/日期等装饰列缺失 → 降级插入(不 brick 核料),提醒执行迁移
        console.warn('[consolidate] 非闸门新列缺失,降级插入。请执行 20260703 系列迁移(images/dates)');
        const { is_supplement, supplement_reason, supplement_requested_by, supplement_requested_at, finance_approval_status, image_urls, required_date, order_by_date, ...plain } = row;
        ({ error: iErr } = await (supabase.from('procurement_items') as any).insert(plain));
      }
      if (iErr) return { error: friendlyError(iErr) };
      created++;
      if (afterProcurementPlaced) {
        const { notifyFinanceSupplement } = await import('@/app/actions/procurement-supplement');
        await notifyFinanceSupplement(supabase, orderId, g.material_name || '物料', g.total, g.unit, '采购下单后核料新增(品类补录)');
      }
    }
  }

  // 6) 孤儿处理(集合在计划阶段已算好;受 cleanup 勾选控制)
  //    - 草稿孤儿 且 无执行行引用 → 删(未下游,无痕移除)
  //    - 已确认/在采购中的孤儿(或草稿却已挂执行行)→ 保留 + 标 needs_reconfirm(已下游动过,人来决策)
  if (apply.cleanup && orphans.length > 0) {
    const deletable = orphans.filter((e: any) => orphanDeletableIds.has(e.id)).map((e: any) => e.id);
    const flagIds = orphans.filter((e: any) => !orphanDeletableIds.has(e.id)).map((e: any) => e.id);
    if (deletable.length > 0) {
      // 保险丝(2026-07-03):带 .select 验证真删了;缺 DELETE 策略时静默 0 行 → 孤儿清理空转
      const { data: reallyDeleted } = await (supabase.from('procurement_items') as any)
        .delete().in('id', deletable).select('id');
      removed += (reallyDeleted || []).length;
      if ((reallyDeleted || []).length < deletable.length) {
        console.warn(`[consolidate] 草稿孤儿清理不完整(${(reallyDeleted || []).length}/${deletable.length}),疑缺 DELETE 策略,请执行 20260703_delete_policies_fix.sql`);
      }
    }
    if (flagIds.length > 0) {
      await (supabase.from('procurement_items') as any).update({ needs_reconfirm: true, updated_at: now }).in('id', flagIds);
      flagged += flagIds.length;
    }
  }

  revalidatePath(`/orders/${orderId}`);
  return { ok: true, created, updated, flagged, removed, syncedLines, total_items: groups.size };
}

/** 来源明细(live):该采购项归并键命中的 requirements ⋈ snapshot_lines。粒度=物料行(产品维度缺口见 P1.md §5.1)。 */
export async function getProcurementItemSources(itemId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: item } = await (supabase.from('procurement_items') as any)
    .select('*').eq('id', itemId).single();   // * → size_qty_override 列未建也不报错
  if (!item) return { error: '采购项不存在' };

  const { data: reqs } = await (supabase.from('material_requirements') as any)
    .select('id, snapshot_line_id, material_name, category, unit, net_purchase_qty')
    .eq('order_id', (item as any).order_id);
  const slIds = Array.from(new Set((reqs || []).map((r: any) => r.snapshot_line_id).filter(Boolean)));
  const slMap = new Map<string, any>();
  if (slIds.length) {
    const { data: sls } = await (supabase.from('material_package_snapshot_lines') as any)
      .select('id, color, specification, qty_per_piece, bom_id, material_name, loss_rate').in('id', slIds);
    for (const s of (sls || [])) slMap.set(s.id, s);
  }
  const bomIds = Array.from(new Set([...slMap.values()].map((s: any) => s.bom_id).filter(Boolean)));
  const bomMaster = new Map<string, string | null>();
  const bomStyle = new Map<string, string | null>();   // bom_id → 款号(多款单辅料要显示,采购才知这批是哪个款的)
  if (bomIds.length) {
    const { data: bs } = await (supabase.from('materials_bom') as any).select('id, material_master_id, style_no').in('id', bomIds);
    for (const b of (bs || [])) { bomMaster.set(b.id, b.material_master_id); bomStyle.set(b.id, b.style_no || null); }
  }

  // 人工合并映射(与 consolidateOrderProcurementItems 同源):两条同物料不同键被采购手动并成一条时,
  // 归并把「源键」重映射到「目标键」。来源明细必须用同一张表重映射,否则被并进来的那个款(源键≠目标键)
  // 会被下面的 key 过滤掉 → 合并后只显示一个款(2026-07-11 用户实测:两个主标合并后款号只剩一个)。
  const mergeMap = new Map<string, string>();
  {
    const { data: cbM } = await (supabase.from('order_cost_baseline') as any)
      .select('consolidation_merges').eq('order_id', (item as any).order_id).maybeSingle();
    for (const m of (((cbM as any)?.consolidation_merges) || [])) {
      if (m?.from && m?.to) mergeMap.set(String(m.from), String(m.to));
    }
  }

  const sources = (reqs || []).map((r: any) => {
    const sl = r.snapshot_line_id ? slMap.get(r.snapshot_line_id) : null;
    const master_id = sl?.bom_id ? (bomMaster.get(sl.bom_id) || null) : null;
    const rawKey = consolidationKey({
      material_master_id: master_id, material_name: r.material_name || sl?.material_name,
      specification: sl?.specification, category: r.category, color: sl?.color, unit: r.unit,
    });
    const key = mergeMap.get(rawKey) || rawKey;   // 人工合并:源键 → 目标键(与归并同口径)
    return { key, material_name: r.material_name || sl?.material_name, color: sl?.color || null,
      style_no: sl?.bom_id ? (bomStyle.get(sl.bom_id) || null) : null,   // 款号(整单通用辅料为 null)
      development_consumption: sl?.qty_per_piece ?? null, net_demand: r.net_purchase_qty ?? null };
  }).filter((s: any) => s.key === (item as any).consolidation_key);

  // 尺码拆分预览(2026-07-08 用户拍板:尺码+最终采购量要体现在上边)——
  // 与 generateExecutionLines 同口径:按订单各码件数(优先本色,无则整单)把出单量拆到尺码。
  // 让采购在确认前就看到"这单最终会按哪些尺码、各买多少",不用等生成执行行。
  const normC = (s: any) => String(s ?? '').trim().toLowerCase();
  const { data: lis } = await (supabase.from('order_line_items') as any)
    .select('style_no, product_name, color_cn, color_en, sizes').eq('order_id', (item as any).order_id);
  const byColorSizes = new Map<string, Record<string, number>>();
  const totalSizes: Record<string, number> = {};
  for (const li of (lis || [])) {
    const sz = (li as any).sizes && typeof (li as any).sizes === 'object' ? (li as any).sizes : {};
    for (const [k, v] of Object.entries(sz)) {
      const n = Number(v) || 0; if (n <= 0) continue;
      totalSizes[k] = (totalSizes[k] || 0) + n;
      for (const col of [(li as any).color_cn, (li as any).color_en]) if (col) {
        const key = normC(col); if (!byColorSizes.has(key)) byColorSizes.set(key, {});
        const m = byColorSizes.get(key)!; m[k] = (m[k] || 0) + n;
      }
    }
  }
  const itemColor = (item as any).color;
  const sizeCounts = (itemColor && byColorSizes.get(normC(itemColor))) || totalSizes;
  const orderable = orderableQty(item as any);
  // 面料/散装物料不按尺码拆分(整卷开裁,采购量不该按各码件数均分)→ 空拆分,预览不显示尺码块。
  const splittable = shouldSplitBySize(item as any);
  // 人工覆盖优先:填了 size_qty_override → 按它逐码显示(生成执行行也按它);否则系统按比例拆
  const override = splittable && (item as any).size_qty_override && typeof (item as any).size_qty_override === 'object' ? (item as any).size_qty_override : null;
  const overrideEntries = override ? Object.entries(override).map(([size, qty]) => ({ size, qty: Number(qty) || 0 })).filter((s) => s.qty > 0) : [];
  const sizeOverrideActive = overrideEntries.length > 0;
  // 2026-07-08 用户:默认不按尺码拆(单行整量);只有采购点「按尺码录入」填了 size_qty_override 才拆。
  // 与 generateExecutionLines 同口径:sizeBreakdown 仅在有人工录入时才逐码,否则空(单行)。
  const sizeBreakdown = (splittable && sizeOverrideActive) ? overrideEntries : [];
  // 系统按比例拆的建议值(供 UI 点开「按尺码录入」时预填参照,不作默认拆分)
  const suggestedSplit = splittable ? distributeBySize(orderable, sizeCounts).filter((s) => s.size != null) : [];
  const finalQty = (item as any).final_purchase_qty ?? (item as any).suggested_purchase_qty ?? (item as any).total_required_qty ?? null;

  // ── 产品明细拆分「款号×颜色×尺码」(吊牌/洗唛等印 SKU 信息的辅料)──
  // 系统建议 = 订单 SKU 件数矩阵(order_line_items)按出单量比例分配;采购可微调。
  // 与尺码同口径:仅按件计数的辅料(splittable)才有;本色收窄由 item.color 决定。
  const skuCells = buildSkuMatrixCells(lis || [], (item as any).color, normC).filter((c) => c.weight > 0);
  const skuDist = distributeByWeights(orderable, skuCells.map((c, i) => ({ key: i, weight: c.weight })));
  const skuQtyByI = new Map<number, number>(skuDist.map((d) => [d.key, d.qty]));
  const skuSuggest = splittable
    ? skuCells.map((c, i) => ({ style_no: c.style_no, product_name: c.product_name, color_cn: c.color_cn, color_en: c.color_en, size: c.size, qty: skuQtyByI.get(i) ?? 0 })).filter((c) => c.qty > 0)
    : [];
  const savedSku = Array.isArray((item as any).sku_breakdown) ? (item as any).sku_breakdown : [];
  const skuActive = splittable && savedSku.length > 0;

  return { data: sources, sizeBreakdown, suggestedSplit, sizeOverrideActive, finalQty, splittable, unit: (item as any).unit ?? null,
    skuSuggest, skuSaved: savedSku, skuActive };
}

/**
 * 采购项人工合并(2026-07-10 用户拍板):把 sourceItem 合并进 targetItem(目标保留、源删除)。
 * 场景:同一辅料(主标/洗标等)因单位录得不一致(米 vs 个)没自动归并,拆成两条 → 人工并一条。
 * 防呆:仅【同物料名】可合并(吊牌×洗标不给合并);仅【草稿】可合并(已确认/已下单不动)。
 * 持久化:把 源归并键→目标归并键 记进 order_cost_baseline.consolidation_merges,重新核料归并也永久并一条
 *   (归并 consolidateOrderProcurementItems 计算键后按此重映射)。数量并入目标,单位取目标。
 */
export async function mergeProcurementItems(orderId: string, sourceItemId: string, targetItemId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const roleErr = await requireProcurementRole(supabase, user.id);
  if (roleErr) return { error: roleErr };
  if (sourceItemId === targetItemId) return { error: '不能合并到自己' };

  const { data: rows } = await (supabase.from('procurement_items') as any)
    .select('*').in('id', [sourceItemId, targetItemId]).eq('order_id', orderId);
  const src = (rows || []).find((r: any) => r.id === sourceItemId);
  const tgt = (rows || []).find((r: any) => r.id === targetItemId);
  if (!src || !tgt) return { error: '采购项不存在或不属于本订单' };
  const norm = (s: any) => String(s ?? '').trim().toLowerCase();
  if (norm(src.material_name) !== norm(tgt.material_name)) {
    return { error: `不同物料不能合并:「${src.material_name || '?'}」≠「${tgt.material_name || '?'}」` };
  }
  if (src.status !== 'draft' || tgt.status !== 'draft') {
    return { error: '仅草稿状态的采购项可合并;已确认/已下单的请先处理' };
  }

  const svc = createServiceRoleClient();
  // 1) 记合并映射(源键→目标键),持久化;链式合并防断(旧映射指向源的改指目标)
  const { data: cb } = await (svc.from('order_cost_baseline') as any)
    .select('id, consolidation_merges').eq('order_id', orderId).maybeSingle();
  const merges: any[] = Array.isArray((cb as any)?.consolidation_merges) ? (cb as any).consolidation_merges : [];
  for (const m of merges) if (m?.to === src.consolidation_key) m.to = tgt.consolidation_key;
  if (!merges.some((m) => m?.from === src.consolidation_key && m?.to === tgt.consolidation_key)) {
    merges.push({ from: src.consolidation_key, to: tgt.consolidation_key });
  }
  if ((cb as any)?.id) {
    const { error } = await (svc.from('order_cost_baseline') as any).update({ consolidation_merges: merges }).eq('order_id', orderId);
    if (error && /consolidation_merges|column .* does not exist/i.test(error.message || '')) {
      return { error: '合并映射列尚未建立:请先在 Supabase 执行 20260710_procurement_manual_merge.sql' };
    }
    if (error) return { error: friendlyError(error) };
  } else {
    const { error } = await (svc.from('order_cost_baseline') as any).insert({ order_id: orderId, consolidation_merges: merges });
    if (error) return { error: friendlyError(error) };
  }

  // 2) 数量并入目标(总需求/建议/来源数求和,单位取目标)。重新归并会按 BOM 重算,此为即时口径。
  const sum = (a: any, b: any) => Math.round(((Number(a) || 0) + (Number(b) || 0)) * 10) / 10;
  await (supabase.from('procurement_items') as any).update({
    total_required_qty: sum(tgt.total_required_qty, src.total_required_qty),
    suggested_purchase_qty: sum(tgt.suggested_purchase_qty, src.suggested_purchase_qty),
    source_count: (Number(tgt.source_count) || 0) + (Number(src.source_count) || 0),
    updated_at: new Date().toISOString(),
  }).eq('id', targetItemId);

  // 3) 源的执行行改挂目标(草稿一般无;有则迁移不丢)
  await (supabase.from('procurement_line_items') as any).update({ procurement_item_id: targetItemId }).eq('procurement_item_id', sourceItemId);

  // 4) 删源采购项
  const { error: delErr } = await (supabase.from('procurement_items') as any).delete().eq('id', sourceItemId);
  if (delErr) return { error: friendlyError(delErr) };

  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}

/** 把订单行(order_line_items)摊平成「款号×颜色×尺码」单元格,权重=该 SKU 件数。
 *  itemColor 有值 → 只保留该颜色的行(本色辅料);为空(整单通用,如吊牌)→ 全部款色码。 */
function buildSkuMatrixCells(
  lis: any[], itemColor: any, normC: (s: any) => string,
): Array<{ style_no: string; product_name: string; color_cn: string; color_en: string; size: string; weight: number }> {
  const cells: Array<{ style_no: string; product_name: string; color_cn: string; color_en: string; size: string; weight: number }> = [];
  const ic = itemColor ? normC(itemColor) : '';
  for (const li of lis) {
    if (ic) {
      const match = [li.color_cn, li.color_en].some((c: any) => c && normC(c) === ic);
      if (!match) continue;
    }
    const sz = li.sizes && typeof li.sizes === 'object' ? li.sizes : {};
    for (const [size, v] of Object.entries(sz)) {
      const n = Number(v) || 0;
      if (n <= 0 || !String(size).trim()) continue;
      cells.push({
        style_no: li.style_no || '', product_name: li.product_name || '',
        color_cn: li.color_cn || '', color_en: li.color_en || '', size: String(size).trim(), weight: n,
      });
    }
  }
  return cells;
}

/**
 * 保存尺码拆分人工覆盖(2026-07-08 用户拍板:采购在核料预览直接改尺码比/每码数量)。
 * sizes 传 {尺码:数量}(数量>0 才留);空对象 = 清空覆盖,恢复系统按比例拆。
 * 覆盖非空时,同步把 final_purchase_qty 定为各码之和(最终采购量=各码总和,单一口径)。
 * 已下单(ordered+)不许改(执行行已生成,改量走补数量/采购队列)。
 */
export async function saveSizeQtyOverride(itemId: string, orderId: string, sizes: Record<string, number | null | undefined>) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const roleErr = await requireProcurementRole(supabase, user.id);
  if (roleErr) return { error: roleErr };   // 尺码拆分是采购职权

  const { data: it } = await (supabase.from('procurement_items') as any)
    .select('status').eq('id', itemId).eq('order_id', orderId).maybeSingle();
  if (!it) return { error: '采购项不存在' };
  if (['ordered', 'partially_received', 'completed', 'closed'].includes((it as any).status)) {
    return { error: '该项已下单/在途,尺码数量改动请走「补数量申请」或采购队列' };
  }

  // 清洗:仅留数量>0 的码;四舍五入到整数(尺码件数是整数);Σ=最终采购量
  const clean: Record<string, number> = {};
  let total = 0;
  for (const [k, v] of Object.entries(sizes || {})) {
    const q = Math.round(Number(v) || 0);
    if (String(k).trim() && q > 0) { clean[String(k).trim()] = q; total += q; }
  }
  const hasOverride = Object.keys(clean).length > 0;
  const patch: Record<string, any> = {
    size_qty_override: hasOverride ? clean : null,
    updated_at: new Date().toISOString(),
  };
  if (hasOverride) patch.final_purchase_qty = total;   // 覆盖时:最终采购量 = 各码之和

  let { error } = await (supabase.from('procurement_items') as any).update(patch).eq('id', itemId).eq('order_id', orderId);
  if (error && /size_qty_override|column .* does not exist/i.test(error.message || '')) {
    return { error: '尺码拆分列尚未建立:请先在 Supabase 执行 20260708_procurement_item_size_override.sql' };
  }
  if (error) return { error: friendlyError(error) };
  // 手动改尺码 = 退出「按产品拆分(款×色×码)」模式:清掉产品矩阵。
  // 独立语句 + 容忍 sku_breakdown 列未建(旧库),不影响尺码拆分本身可用。
  await (supabase.from('procurement_items') as any).update({ sku_breakdown: null }).eq('id', itemId).eq('order_id', orderId);
  revalidatePath(`/orders/${orderId}`);
  return { ok: true, total, cleared: !hasOverride };
}

/**
 * 保存产品明细拆分「款号×颜色×尺码」(2026-07-10 用户拍板:吊牌等辅料印 SKU 信息,
 * 供应商要按款×色×码分别印/采购)。cells 传 [{style_no,product_name,color_cn,color_en,size,qty}](qty>0 才留);
 * 空数组 = 清空产品拆分,回到不按产品拆。
 * 非空时:① 存 sku_breakdown(驱动采购单产品明细附页);② 各码合计回写 size_qty_override
 * (执行行/收货/财务/主采购单表按尺码照旧走,零改动);③ final_purchase_qty = Σqty。
 * 已下单(ordered+)不许改。
 */
export async function saveSkuBreakdown(
  itemId: string, orderId: string,
  cells: Array<{ style_no?: string; product_name?: string; color_cn?: string; color_en?: string; size?: string; qty?: number | null }>,
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const roleErr = await requireProcurementRole(supabase, user.id);
  if (roleErr) return { error: roleErr };   // 产品拆分是采购职权

  const { data: it } = await (supabase.from('procurement_items') as any)
    .select('status').eq('id', itemId).eq('order_id', orderId).maybeSingle();
  if (!it) return { error: '采购项不存在' };
  if (['ordered', 'partially_received', 'completed', 'closed'].includes((it as any).status)) {
    return { error: '该项已下单/在途,数量改动请走「补数量申请」或采购队列' };
  }

  // 清洗:qty 取整>0 才留;累计总量 + 按尺码聚合(回写 size_qty_override)
  const clean: Array<Record<string, any>> = [];
  const sizeTotals: Record<string, number> = {};
  let total = 0;
  for (const c of (cells || [])) {
    const q = Math.round(Number(c?.qty) || 0);
    if (q <= 0) continue;
    const size = String(c?.size ?? '').trim();
    clean.push({
      style_no: String(c?.style_no ?? '').trim(),
      product_name: String(c?.product_name ?? '').trim(),
      color_cn: String(c?.color_cn ?? '').trim(),
      color_en: String(c?.color_en ?? '').trim(),
      size, qty: q,
    });
    total += q;
    if (size) sizeTotals[size] = (sizeTotals[size] || 0) + q;
  }
  const hasBreakdown = clean.length > 0;
  const patch: Record<string, any> = {
    sku_breakdown: hasBreakdown ? clean : null,
    // 各码合计 → size_qty_override:执行/收货/财务/主采购单表按尺码照旧;无尺码则清空
    size_qty_override: hasBreakdown && Object.keys(sizeTotals).length > 0 ? sizeTotals : null,
    updated_at: new Date().toISOString(),
  };
  if (hasBreakdown) patch.final_purchase_qty = total;   // 最终采购量 = 各格之和

  const { error } = await (supabase.from('procurement_items') as any).update(patch).eq('id', itemId).eq('order_id', orderId);
  if (error && /sku_breakdown|column .* does not exist/i.test(error.message || '')) {
    return { error: '产品拆分列尚未建立:请先在 Supabase 执行 20260710_procurement_item_sku_breakdown.sql' };
  }
  if (error) return { error: friendlyError(error) };
  revalidatePath(`/orders/${orderId}`);
  return { ok: true, total, cleared: !hasBreakdown };
}

/** 采购确认:填大货单耗/损耗/安全库存/MOQ/供应商/价/决策,重算 suggested。 */
/** 核料确认/参数编辑 = 采购的职权(2026-07-03 用户拍板:归并后必须采购确认才安全) */
async function requireProcurementRole(supabase: any, userId: string): Promise<string | null> {
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles').eq('user_id', userId).single();
  const roles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  return roles.some(r => ['procurement', 'procurement_manager', 'admin'].includes(r))
    ? null : '仅采购/采购经理/管理员可编辑和确认核料(业务执行请走「补数量申请」)';
}

export async function updateProcurementItem(itemId: string, orderId: string, fields: Record<string, any>) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const roleErr = await requireProcurementRole(supabase, user.id);
  if (roleErr) return { error: roleErr };

  const { data: item } = await (supabase.from('procurement_items') as any)
    .select('total_required_qty, development_consumption, lead_days').eq('id', itemId).single();
  if (!item) return { error: '采购项不存在' };

  const numFields = ['production_consumption', 'procurement_loss_pct', 'safety_stock_qty', 'final_purchase_qty', 'lead_days', 'moq', 'unit_price', 'tax_rate'];
  const boolFields = ['is_substitute', 'is_split', 'is_outsourced', 'risk_flag', 'price_inclusive_tax'];
  const textFields = ['confirmed_supplier_name', 'backup_supplier_name', 'supplier_contact', 'purchase_unit', 'currency', 'substitute_reason', 'risk_note', 'procurement_notes', 'purchase_spec'];

  const upd: any = { updated_at: new Date().toISOString() };
  for (const k of numFields) if (k in fields) upd[k] = num(fields[k]);
  for (const k of boolFields) if (k in fields) upd[k] = !!fields[k];
  for (const k of textFields) if (k in fields) upd[k] = fields[k] || null;
  if ('quote_date' in fields) upd.quote_date = fields.quote_date || null;

  // 需到日(采购手选,货到厂日):锁定后归并不覆盖;派生最晚下单日 = 需到日 − 供应商交期(日历日近似)
  if ('required_date' in fields) {
    const rd = fields.required_date ? String(fields.required_date).slice(0, 10) : null;
    if (rd) {
      upd.required_date = rd;
      upd.required_date_locked = true;
      const lead = Number(upd.lead_days ?? (item as any).lead_days) || 0;
      if (lead > 0 && /^\d{4}-\d{2}-\d{2}$/.test(rd)) {
        const [y, m, d] = rd.split('-').map(Number);
        upd.order_by_date = new Date(Date.UTC(y, m - 1, d) - lead * 86400000).toISOString().slice(0, 10);
      } else {
        upd.order_by_date = rd;
      }
    } else {
      upd.required_date_locked = false;   // 清空锁 → 恢复系统倒推(下次归并重算)
    }
  }

  // 重算 suggested(用新输入)
  upd.suggested_purchase_qty = computeSuggestedPurchaseQty({
    total_required_qty: (item as any).total_required_qty,
    development_consumption: (item as any).development_consumption,
    production_consumption: upd.production_consumption ?? undefined,
    procurement_loss_pct: upd.procurement_loss_pct ?? undefined,
    safety_stock_qty: upd.safety_stock_qty ?? undefined,
    moq: upd.moq ?? undefined,
  });

  let { error } = await (supabase.from('procurement_items') as any).update(upd).eq('id', itemId);
  if (error && /purchase_spec/i.test(error.message || '')) {
    // 采购规格列迁移未跑 → 去掉该列重试(其余字段照存,规格待迁移后再存)
    delete upd.purchase_spec;
    ({ error } = await (supabase.from('procurement_items') as any).update(upd).eq('id', itemId));
  }
  if (error && /required_date_locked|column .* does not exist/i.test(error.message || '')) {
    // 迁移未跑 → 去掉锁标志重试(需到日/最晚下单日仍写入,只是不"锁"、可能被下次归并覆盖)
    const { required_date_locked, ...rest } = upd;
    ({ error } = await (supabase.from('procurement_items') as any).update(rest).eq('id', itemId));
  }
  if (error) return { error: friendlyError(error) };
  // 需到日改了 → 同步所有执行行的 required_by(缺料风险/供应商延期/在途灯立刻用新到货日)。
  // 修:此前只更"未下单"行(.is purchase_order_id null),导致已下单/在途行改了需到日不生效——
  //     而供应商延期风险正是针对在途行,采购手选的到货日永远追不上,风险卡一直卡在旧日期。
  if ('required_date' in upd) {
    try {
      await (supabase.from('procurement_line_items') as any)
        .update({ required_by: upd.required_date, updated_at: new Date().toISOString() })
        .eq('procurement_item_id', itemId);
    } catch { /* 不阻断 */ }
  }
  // 采购填/改了单价 →
  //  ① 回写所有执行行 unit_price:执行行的 unit_price 是「生成执行行那一刻」的核料快照,
  //     采购之后才在核料层填/改单价 → 执行行仍为空 → 采购单/对账「金额」「底价」一直显示「—」。
  //     ordered_amount 是 GENERATED 列(=ordered_qty×unit_price),回填 unit_price 后 DB 自动算金额。
  //     底价列走 service_role 写(20260704 底价列级封锁:authenticated 读不到价列,写也统一走 service_role)。
  //  ② 重算「实际辅料总价」并即时推财务(2026-07-08 用户拍板 A;幂等,改了才推)
  if ('unit_price' in fields) {
    try {
      await (createServiceRoleClient().from('procurement_line_items') as any)
        .update({ unit_price: upd.unit_price ?? null, updated_at: new Date().toISOString() })
        .eq('procurement_item_id', itemId);
    } catch { /* 不阻断 */ }
    try { const { recomputeOrderBudgetCaches } = await import('@/app/actions/quote-baseline'); await recomputeOrderBudgetCaches(orderId); } catch { /* 不阻断 */ }
  }
  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}

/**
 * 更新采购项图片(色卡/辅料参考图)。
 * 与核料参数不同:图片是证据,业务执行和采购都可增删(2026-07-03 用户拍板)。
 */
export async function updateProcurementItemImages(itemId: string, orderId: string, imageUrls: string[]) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  if (!roles.some(r => ['sales', 'sales_manager', 'order_manager', 'merchandiser', 'procurement', 'procurement_manager', 'admin'].includes(r))) {
    return { error: '无权更新图片' };
  }
  const clean = (Array.isArray(imageUrls) ? imageUrls : [])
    .filter(u => typeof u === 'string' && /^https?:\/\//.test(u)).slice(0, 8);
  const { error } = await (supabase.from('procurement_items') as any)
    .update({ image_urls: clean, updated_at: new Date().toISOString() }).eq('id', itemId);
  if (error) {
    if (/image_urls|column .* does not exist/i.test(error.message || '')) {
      return { error: '图片列尚未建立:请先在 Supabase 执行 20260703_procurement_item_images.sql' };
    }
    return { error: friendlyError(error) };
  }
  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}

/** 更新采购项的排版稿/文件附件(业务/采购都可增删)。files=[{name,url}];url 须公网可下载,封顶 12。 */
export async function updateProcurementItemAttachments(itemId: string, orderId: string, files: Array<{ name?: string; url?: string }>) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  if (!roles.some(r => ['sales', 'sales_manager', 'order_manager', 'merchandiser', 'procurement', 'procurement_manager', 'admin'].includes(r))) {
    return { error: '无权更新附件' };
  }
  const clean = (Array.isArray(files) ? files : [])
    .filter(f => f && typeof f.url === 'string' && /^https?:\/\//.test(f.url))
    .map(f => ({ name: String(f.name || f.url).slice(0, 200), url: String(f.url) }))
    .slice(0, 12);
  const { error } = await (supabase.from('procurement_items') as any)
    .update({ attachment_files: clean, updated_at: new Date().toISOString() }).eq('id', itemId);
  if (error) {
    if (/attachment_files|column .* does not exist/i.test(error.message || '')) {
      return { error: '附件列尚未建立:请先在 Supabase 执行 20260710_material_attachment_files.sql' };
    }
    return { error: friendlyError(error) };
  }
  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}

/** 生命周期推进。confirmed→记确认留痕 + 来源版本快照 + 清 needs_reconfirm。 */
export async function updateProcurementItemStatus(itemId: string, orderId: string, status: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const roleErr = await requireProcurementRole(supabase, user.id);
  if (roleErr) return { error: roleErr };
  const VALID = ['draft', 'reviewing', 'confirmed', 'ordered', 'partially_received', 'completed', 'closed'];
  if (!VALID.includes(status)) return { error: '非法状态' };

  // 补采购闸:未获财务批准的补采购项,不允许推进到 confirmed 及之后(生成执行行只认 confirmed)
  if (['confirmed', 'ordered', 'partially_received', 'completed'].includes(status)) {
    const { data: it } = await (supabase.from('procurement_items') as any)
      .select('is_supplement, finance_approval_status, finance_reject_reason').eq('id', itemId).maybeSingle();
    if ((it as any)?.is_supplement) {
      const fs = (it as any).finance_approval_status;
      if (fs === 'pending') return { error: '🟠 补采购待财务审批,批准后才能确认采购(财务已收到通知)' };
      if (fs === 'rejected') return { error: `补采购已被财务驳回:${(it as any).finance_reject_reason || '无原因'}。如仍需采购请重新提交申请` };
    }

    // 超预算闸(2026-07-08 弃用报价基线):采购单价 > 业务在采购核料填的预算单价(容差0)→ 必须先经财务审批。
    try {
      // ⚠️ P1 修:原 select 查了 procurement_items 不存在的 style_no 列 → PostgREST 报错、
      // 只解构 data 忽略 error → bi=null → 整个超预算闸静默跳过(采购超预算照样确认下单)。
      // procurement_items 无款号(归并层丢 style),按物料+颜色匹配预算即可;并检查 error 不再吞。
      const { data: bi, error: biErr } = await (supabase.from('procurement_items') as any)
        .select('material_name, color, unit_price, baseline_over_status').eq('id', itemId).maybeSingle();
      if (biErr) console.warn('[超预算闸] 读采购项失败,本次降级不拦:', biErr.message);
      const { data: bomRows } = await (supabase.from('materials_bom') as any)
        .select('material_name, color, style_no, budget_unit_price').eq('order_id', orderId);
      const budgetLines = ((bomRows || []) as any[])
        .filter((b) => Number(b.budget_unit_price) > 0)
        .map((b) => ({ style_no: b.style_no, material_name: b.material_name, color: b.color, quote_consumption: null, quote_unit_price: Number(b.budget_unit_price) }));
      if (bi && budgetLines.length > 0) {
        const { matchBaseline, checkOverBaseline } = await import('@/lib/domain/cost-baseline');
        // 采购项无 style_no → 传 null,matchBaseline 退化为物料+颜色匹配(款级精度缺口是已知 P2)
        const base = matchBaseline(budgetLines, (bi as any).material_name, (bi as any).color, null);
        const chk = base.matched ? checkOverBaseline(base, null, (bi as any).unit_price ?? null) : null;
        if (chk && chk.over_price) {
          const st = (bi as any).baseline_over_status;
          if (st === 'rejected') return { error: '超预算已被财务驳回,不能确认。请调整供应商价,或让财务重新审批' };
          if (st === 'pending') return { error: '🔴 超预算待财务审批,批准后才能确认(财务已收到通知)' };
          if (st !== 'approved') {
            const note = `采购单价超预算 +${chk.price_over_pct}%`;
            await (supabase.from('procurement_items') as any).update({
              baseline_over_status: 'pending', baseline_over_note: note,
              baseline_over_requested_by: user.id, baseline_over_requested_at: new Date().toISOString(),
            }).eq('id', itemId);
            // 通知财务(fire-and-forget)
            try {
              const { data: order } = await (supabase.from('orders') as any).select('order_no, internal_order_no').eq('id', orderId).maybeSingle();
              const { data: profs } = await (supabase.from('profiles') as any).select('user_id, role, roles');
              const fin = (profs || []).filter((p: any) => { const rs = p.roles?.length ? p.roles : [p.role]; return rs.includes('finance') || rs.includes('admin'); });
              if (fin.length) await (supabase.from('notifications') as any).insert(fin.map((f: any) => ({
                user_id: f.user_id, type: 'baseline_over',
                title: `🔴 超预算待审批:${(order as any)?.internal_order_no || (order as any)?.order_no || ''}`,
                message: `「${(bi as any).material_name || ''}${(bi as any).color ? ' · ' + (bi as any).color : ''}」${note}。需财务审批后采购才能确认。`,
                related_order_id: orderId,
              })));
            } catch { /* 通知失败不影响拦截 */ }
            return { error: `🔴 超预算(${note}),已自动提交财务审批,批准后才能确认` };
          }
        }
      }
    } catch { /* 超预算闸异常不阻断(降级=不拦,避免误锁;审计可查) */ }
  }

  const now = new Date().toISOString();
  const upd: any = { status, updated_at: now };
  if (status === 'confirmed') {
    upd.confirmed_by = user.id; upd.confirmed_at = now; upd.needs_reconfirm = false;
    // 来源快照(审计/判过期)
    const src = await getProcurementItemSources(itemId);
    if ((src as any).data) upd.confirmed_source_snapshot = (src as any).data;
  }
  const { error } = await (supabase.from('procurement_items') as any).update(upd).eq('id', itemId);
  if (error) return { error: friendlyError(error) };

  // 转复核 → 通知全体采购经理(拿不准的项由经理拍板;fire-and-forget 不阻塞)
  if (status === 'reviewing') {
    try {
      const { data: it } = await (supabase.from('procurement_items') as any)
        .select('item_no, material_name, color').eq('id', itemId).maybeSingle();
      const { data: order } = await (supabase.from('orders') as any)
        .select('order_no, customer_name').eq('id', orderId).maybeSingle();
      const { data: profs } = await (supabase.from('profiles') as any).select('user_id, role, roles');
      const managers = (profs || []).filter((p: any) => {
        const rs: string[] = p.roles?.length > 0 ? p.roles : [p.role].filter(Boolean);
        return rs.includes('procurement_manager') || rs.includes('admin');
      });
      if (managers.length > 0) {
        await (supabase.from('notifications') as any).insert(managers.map((m: any) => ({
          user_id: m.user_id,
          type: 'procurement_review',
          title: `⏳ 核料待复核:${(order as any)?.order_no || ''}`,
          message: `采购项「${(it as any)?.material_name || ''}${(it as any)?.color ? ' · ' + (it as any).color : ''}」(${(it as any)?.item_no || ''})被转来复核,请到订单「采购核料」查看并确认。`,
          related_order_id: orderId,
        })));
      }
    } catch { /* 通知失败不阻塞转复核 */ }
  }

  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}

// ════════════════════════════════════════════════════════════════════════
// B3a 执行链打通:采购项(确认)→ 执行行 · 收货状态联动 · 领料核销派生
// ADR-004 第3层→第4层。本阶段起本 action 可写 procurement_line_items(桥),
// 老手工建行入口不动(并存);FK=procurement_item_id(不锚易失 requirement_id)。
// ════════════════════════════════════════════════════════════════════════

/** 桥:已确认(confirmed)且未生成过的采购项 → 生成采购执行行(挂 procurement_item_id)。幂等。 */
export async function generateExecutionLines(orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  // 门禁(2026-07-05 审计 P1):此前只查登录,任何登录用户可为任意订单批量生成执行行(执行层越权写)。
  const roleErr = await requireProcurementRole(supabase, user.id);
  if (roleErr) return { error: roleErr };

  const { data: items, error: iErr } = await (supabase.from('procurement_items') as any)
    .select('*')   // * → size_qty_override 列未建也不报错(buildExecutionLineRow 只取所需字段)
    .eq('order_id', orderId).eq('status', 'confirmed');
  if (iErr) return { error: friendlyError(iErr) };
  if (!items || items.length === 0) return { error: '无已确认的采购项(请先在采购项上「确认」)' };

  // 已生成过执行行的 item(幂等,不重建)
  const { data: existLines } = await (supabase.from('procurement_line_items') as any)
    .select('procurement_item_id').eq('order_id', orderId).not('procurement_item_id', 'is', null);
  const done = new Set((existLines || []).map((l: any) => l.procurement_item_id));

  // N1:订单各码件数(按颜色分 + 整单总),用于把采购量按尺码分摊到执行行
  const { data: lis } = await (supabase.from('order_line_items') as any)
    .select('color_cn, color_en, sizes').eq('order_id', orderId);
  const normC = (s: any) => String(s ?? '').trim().toLowerCase();
  const byColorSizes = new Map<string, Record<string, number>>();
  const totalSizes: Record<string, number> = {};
  for (const li of (lis || [])) {
    const sz = (li as any).sizes && typeof (li as any).sizes === 'object' ? (li as any).sizes : {};
    for (const [k, v] of Object.entries(sz)) {
      const n = Number(v) || 0; if (n <= 0) continue;
      totalSizes[k] = (totalSizes[k] || 0) + n;
      for (const col of [(li as any).color_cn, (li as any).color_en]) if (col) {
        const key = normC(col); if (!byColorSizes.has(key)) byColorSizes.set(key, {});
        const m = byColorSizes.get(key)!; m[k] = (m[k] || 0) + n;
      }
    }
  }
  const sizeCountsFor = (it: any): Record<string, number> => (it.color && byColorSizes.get(normC(it.color))) || totalSizes;

  const now = new Date().toISOString();
  const rows = (items as any[])
    // 出单量>0 才生成执行行:定案量−库存抵扣=0(全用库存)的项不采购、不发供应商
    .filter((it) => !done.has(it.id) && canGenerateExecution(it) && orderableQty(it) > 0)
    // 尺码拆分改为「采购主动录入」opt-in(2026-07-08 用户:辅料很多不带尺码,不再全部自动按码拆)。
    // 默认单行整量(size=null);仅当采购在核料点「按尺码录入」填了 size_qty_override 才按码拆。面料/散装恒单行。
    .flatMap((it) => {
      const ov = (it as any).size_qty_override && typeof (it as any).size_qty_override === 'object' ? (it as any).size_qty_override : null;
      const overrideSegs = ov ? Object.entries(ov).map(([size, qty]) => ({ size, qty: Number(qty) || 0 })).filter((s) => s.qty > 0) : [];
      if (overrideSegs.length === 0 || !shouldSplitBySize(it)) {
        return [{ ...buildExecutionLineRow(it, user.id, { size: null, qtyOverride: orderableQty(it) }), ordered_at: now }];
      }
      return overrideSegs.map((seg) => ({ ...buildExecutionLineRow(it, user.id, { size: seg.size, qtyOverride: seg.qty }), ordered_at: now }));
    });
  if (rows.length === 0) return { ok: true, created: 0, message: '已确认项无需采购(全用库存抵扣)或均已生成执行行' };

  let { error: insErr } = await (supabase.from('procurement_line_items') as any).insert(rows);
  if (insErr && /\bsize\b|column .* does not exist/i.test(insErr.message || '')) {
    // size 迁移(20260707)未跑 → 降级去 size 列重插(退回不分码,不 brick 生成)
    const plain = rows.map(({ size, ...rest }) => rest);
    ({ error: insErr } = await (supabase.from('procurement_line_items') as any).insert(plain));
  }
  if (insErr) return { error: friendlyError(insErr) };
  revalidatePath(`/orders/${orderId}`);
  return { ok: true, created: rows.length };
}

/** 领料核销派生视图:逐采购项 需求/下单/收货/消耗/尾货(单一来源,不落库)。 */
export async function getOrderProcurementFulfillment(orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: items } = await (supabase.from('procurement_items') as any)
    .select('id, consolidation_key, material_name, color, unit, total_required_qty, status').eq('order_id', orderId);
  if (!items || items.length === 0) return { data: [] };

  const itemIds = (items as any[]).map((i) => i.id);
  const { data: lines } = await (supabase.from('procurement_line_items') as any)
    .select('procurement_item_id, ordered_qty, received_qty').eq('order_id', orderId).in('procurement_item_id', itemIds);
  const lo = await getOrderLeftover(orderId);
  const leftoverRows = (lo as any).data || [];
  return { data: deriveFulfillment(items as any[], (lines || []) as any[], leftoverRows) };
}

/** 状态联动:按执行行收货量重算该订单关联采购项收货状态(只进不退)。收货钩子 fire-and-forget 调用。 */
export async function syncProcurementItemReceivingStatus(orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: items } = await (supabase.from('procurement_items') as any)
    .select('id, status').eq('order_id', orderId);
  if (!items || items.length === 0) return { ok: true, changed: 0 };
  const { data: lines } = await (supabase.from('procurement_line_items') as any)
    .select('procurement_item_id, ordered_qty, received_qty').eq('order_id', orderId).not('procurement_item_id', 'is', null);

  const agg = new Map<string, { ordered: number; received: number }>();
  for (const l of (lines || []) as any[]) {
    const a = agg.get(l.procurement_item_id) || { ordered: 0, received: 0 };
    a.ordered += Number(l.ordered_qty) || 0; a.received += Number(l.received_qty) || 0;
    agg.set(l.procurement_item_id, a);
  }
  let changed = 0;
  const now = new Date().toISOString();
  for (const it of (items as any[])) {
    const a = agg.get(it.id); if (!a) continue;
    const next = resolveReceivingStatus(it.status, a.received, a.ordered);
    if (next !== it.status) {
      await (supabase.from('procurement_items') as any).update({ status: next, updated_at: now }).eq('id', it.id);
      changed++;
    }
  }

  // 审计修(2026-07-04):整单料齐 → 自动完成「原料到厂检验」里程碑 + 重算交付置信度,
  // 与「采购下单」节点自动完成对齐,否则收齐后风险卡仍显示原料未到直到手工勾节点。
  try {
    const allReceived = (items as any[]).length > 0 && (items as any[]).every((it: any) => {
      const a = agg.get(it.id); return a && a.ordered > 0 && a.received >= a.ordered;
    });
    if (allReceived) {
      const { data: ms } = await (supabase.from('milestones') as any)
        .select('id, status').eq('order_id', orderId).eq('step_key', 'materials_received_inspected').maybeSingle();
      const st = String((ms as any)?.status || '').toLowerCase();
      if (ms && st !== 'done' && st !== '已完成') {
        await (supabase.from('milestones') as any)
          .update({ status: 'done', completed_at: now, actual_at: now, updated_at: now }).eq('id', (ms as any).id);
        await (supabase.from('milestone_logs') as any).insert({
          milestone_id: (ms as any).id, order_id: orderId, action: 'status_transition',
          note: '全部原料已收齐验收 → 系统自动完成「原料到厂检验」节点(收货记录即证据)',
          payload: { auto: true, source: 'materials_received' },
        }).then(() => {}, () => {});
        void (async () => {
          try {
            const { recomputeDeliveryConfidence } = await import('@/app/actions/runtime-confidence');
            await recomputeDeliveryConfidence(orderId, {
              type: 'milestone_status_changed', source: `milestone:${(ms as any).id}`, severity: 'info',
              payload: { milestone_id: (ms as any).id, new_status: 'done', auto: 'materials_received' },
            });
          } catch { /* 忽略 */ }
        })();
      }
    }
  } catch (e: any) { console.warn('[syncProcurementItemReceivingStatus] 料齐里程碑联动失败(不阻断):', e?.message); }

  return { ok: true, changed };
}

/** 状态联动:采购单 placed → 该单执行行关联采购项 confirmed→ordered。下单钩子 fire-and-forget 调用。
 *  P0 复审修:可传入 client(财务回调 webhook 无 cookie 会话,须用传入的 service-role,否则静默 no-op 致订单永卡待采购)。 */
export async function syncProcurementItemsOrderedForPO(purchaseOrderId: string, client?: any) {
  const supabase = client || await createClient();
  if (!client) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: '请先登录' };
  }

  const { data: lines } = await (supabase.from('procurement_line_items') as any)
    .select('procurement_item_id').eq('purchase_order_id', purchaseOrderId).not('procurement_item_id', 'is', null);
  const ids = Array.from(new Set((lines || []).map((l: any) => l.procurement_item_id).filter(Boolean)));
  if (ids.length === 0) return { ok: true, changed: 0 };

  const { data: items } = await (supabase.from('procurement_items') as any).select('id, status').in('id', ids);
  let changed = 0;
  const now = new Date().toISOString();
  for (const it of (items || []) as any[]) {
    const next = resolveOrderedStatus(it.status);
    if (next !== it.status) {
      await (supabase.from('procurement_items') as any).update({ status: next, updated_at: now }).eq('id', it.id);
      changed++;
    }
  }
  return { ok: true, changed };
}

/**
 * 删除整条采购项(2026-07-07 用户拍板)。仅「草稿」且无已归采购单的执行行才可删;删前连带清未归单执行行。
 * 已下单/进流程的采购项不能删(走取消/补量),避免与采购单/收货错位。
 */
export async function deleteProcurementItemRow(itemId: string): Promise<{ ok?: boolean; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data: profile } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (profile as any)?.roles?.length ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  if (!roles.some((r) => ['procurement', 'procurement_manager', 'admin'].includes(r))) return { error: '仅采购/管理员可删除采购项' };

  const svc = createServiceRoleClient();
  const { data: item } = await (svc.from('procurement_items') as any)
    .select('id, order_id, status, item_no').eq('id', itemId).maybeSingle();
  if (!item) return { error: '采购项不存在(可能已删)' };
  if ((item as any).status !== 'draft') return { error: `仅「草稿」采购项可删除(当前:${(item as any).status})。已进采购流程的请走取消/补量` };

  const { data: placed } = await (svc.from('procurement_line_items') as any)
    .select('id').eq('procurement_item_id', itemId).not('purchase_order_id', 'is', null).limit(1);
  if ((placed || []).length > 0) return { error: '该采购项已有执行行归入采购单,不能删除' };

  await (svc.from('procurement_line_items') as any).delete().eq('procurement_item_id', itemId).is('purchase_order_id', null);
  const { error } = await (svc.from('procurement_items') as any).delete().eq('id', itemId);
  if (error) return { error: error.message };
  revalidatePath(`/orders/${(item as any).order_id}`);
  return { ok: true };
}

/**
 * 一次性清理:把历史按尺码拆开的执行行合并回「每料一条」(2026-07-09 用户拍板 B)。
 * 生成执行行现已默认不拆码,本函数治遗留:同一采购单+采购项(退回 物料+颜色)的多条尺码行 →
 * 合并成一条(数量求和·size 清空·取最保守状态·需到日取最早)。
 * 安全闸:任一行已收货(received>0)的组不合并(避免丢收货数据),跳过并回报。
 * 财务:PO 应付总额不变(数量总和不变),重推受影响采购单让 kept 行 qty 对齐;删掉的旧行财务侧留存但永不核销(无害)。
 */
export async function mergeSplitExecutionLines(orderId: string): Promise<{ ok?: true; mergedGroups?: number; deleted?: number; skipped?: string[]; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const roleErr = await requireProcurementRole(supabase, user.id);
  if (roleErr) return { error: roleErr };
  const svc = createServiceRoleClient();

  const { data: lines } = await (svc.from('procurement_line_items') as any)
    .select('id, purchase_order_id, procurement_item_id, material_name, color, size, line_status, ordered_qty, received_qty, required_by')
    .eq('order_id', orderId);
  if (!lines || lines.length === 0) return { ok: true, mergedGroups: 0, deleted: 0, skipped: [] };

  const RANK: Record<string, number> = { draft: 0, pending_order: 1, ordered: 2, confirmed: 3, in_production: 4, ready_to_ship: 5, shipped: 6, arrived: 7 };
  const norm = (s: any) => String(s ?? '').trim().toLowerCase();
  const groups = new Map<string, any[]>();
  for (const l of (lines as any[])) {
    const key = `${l.purchase_order_id || ''}¦${l.procurement_item_id || `${norm(l.material_name)}|${norm(l.color)}`}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(l);
  }

  let mergedGroups = 0, deleted = 0; const skipped: string[] = []; const affectedPOs = new Set<string>();
  const now = new Date().toISOString();
  for (const grp of groups.values()) {
    if (grp.length <= 1) continue;   // 单行不用合
    if (grp.some((l: any) => Number(l.received_qty) > 0)) { skipped.push(`${grp[0].material_name || '?'}(已有收货,未合并)`); continue; }
    grp.sort((a: any, b: any) => (RANK[a.line_status] ?? 0) - (RANK[b.line_status] ?? 0));
    const keep = grp[0];   // 最保守(最不推进)的一条作主
    const sumQty = grp.reduce((s: number, l: any) => s + (Number(l.ordered_qty) || 0), 0);
    const reqs = grp.map((l: any) => l.required_by).filter(Boolean).sort();
    const upd: any = { ordered_qty: Math.round(sumQty * 1000) / 1000, size: null, updated_at: now };
    if (reqs.length) upd.required_by = reqs[0];
    const { error: uErr } = await (svc.from('procurement_line_items') as any).update(upd).eq('id', keep.id);
    if (uErr) { skipped.push(`${grp[0].material_name || '?'}:${uErr.message}`); continue; }
    const delIds = grp.slice(1).map((l: any) => l.id);
    const { error: dErr } = await (svc.from('procurement_line_items') as any).delete().in('id', delIds);
    if (dErr) { skipped.push(`${grp[0].material_name || '?'}:删除失败 ${dErr.message}`); continue; }
    mergedGroups++; deleted += delIds.length;
    if (keep.purchase_order_id) affectedPOs.add(keep.purchase_order_id);
  }

  // 财务重推受影响采购单(kept 行数量对齐;PO 应付总额不变)
  if (affectedPOs.size) {
    try {
      const { syncPurchaseOrderToFinance, fetchPurchaseOrderLinesRaw, fetchSupplierName, fetchOrderRefs } = await import('@/lib/integration/finance-sync');
      for (const poId of affectedPOs) {
        const { data: full } = await (svc.from('purchase_orders') as any).select('*').eq('id', poId).maybeSingle();
        if (!full) continue;
        const st = String((full as any).status || '');
        if (!['placed', 'confirmed', 'receiving', 'received', 'closed'].includes(st)) continue;
        (full as any).supplier_name = await fetchSupplierName(svc, (full as any).supplier_id);
        const orderRefs = await fetchOrderRefs(svc, (full as any).order_ids);
        const poLines = await fetchPurchaseOrderLinesRaw(svc, poId);
        await syncPurchaseOrderToFinance(full, orderRefs, [], poLines);
      }
    } catch (e: any) { console.warn('[mergeSplitExecutionLines] 财务重推失败(不阻断):', e?.message); }
  }

  revalidatePath(`/orders/${orderId}`);
  return { ok: true, mergedGroups, deleted, skipped };
}
