'use server';

/**
 * Procurement Item(采购核料项)—— P1′。
 * 同订单内按 物料身份+颜色+单位 自动归并 material_requirements → 采购确认 → 生命周期。
 * Constitution 02(需求量 live 引用不复制)/ 03(生命周期)/ 04(本表=采购层)。
 * 红线:不改 O1/O2/B1/material_requirements/procurement_line_items/现有采购中心;只读 join 引用上游;不接 AI。
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { friendlyError } from '@/lib/utils/db-error';
import { hasRoleInGroup } from '@/lib/domain/roles';
import { consolidationKey, computeSuggestedPurchaseQty, type IdentityInput } from '@/lib/services/procurement-consolidation';
import {
  buildExecutionLineRow, canGenerateExecution, resolveReceivingStatus, resolveOrderedStatus, deriveFulfillment, orderableQty,
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

  // 报价基线对照(P2):按物料+颜色匹配冻结的报价基线,判超单耗/超价(容差 0,超即报警;超需财务审批)。
  // 在剥价前算(用 unit_price 比对),剥价时同步剥基线价字段。
  try {
    const { data: cb } = await (supabase.from('order_cost_baseline') as any)
      .select('quote_baseline_lines').eq('order_id', orderId).maybeSingle();
    const baseLines = (((cb as any)?.quote_baseline_lines) || []) as any[];
    if (baseLines.length > 0) {
      const { matchBaseline, checkOverBaseline } = await import('@/lib/domain/cost-baseline');
      for (const r of (data || [])) {
        const base = matchBaseline(baseLines, (r as any).material_name, (r as any).color);
        (r as any).baseline = base.matched ? checkOverBaseline(base, (r as any).production_consumption ?? null, (r as any).unit_price ?? null) : null;
      }
    }
  } catch { /* 基线对照失败不影响列表 */ }

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
  const rows = (data || []).map((b: any) => ({
    id: b.id,
    style_no: b.style_no || null,
    color: b.color || null,
    material_name: b.material_name || null,
    material_type: b.material_type || null,
    spec: b.spec || null,
    unit: b.unit || null,
    development_consumption: b.qty_per_piece ?? null,          // 开发单耗(业务,只读)
    production_consumption: b.production_consumption ?? null,  // 大货单耗(采购核定)
    required: b.material_type === 'fabric' || b.material_type === 'lining',  // 布料必核
  }));
  return { data: rows };
}

/** 保存按款大货单耗(采购职权;批量 {bom_id: 值})。 */
export async function saveBomProductionConsumption(orderId: string, entries: Record<string, number | null>) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const roleErr = await requireProcurementRole(supabase, user.id);
  if (roleErr) return { error: roleErr };

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
  const bomExtra = new Map<string, { prod: number | null; style_no: string | null }>();
  if (bomIds.length) {
    const { data: bs } = await (supabase.from('materials_bom') as any).select('*').in('id', bomIds);
    for (const b of (bs || [])) {
      bomMaster.set(b.id, b.material_master_id);
      if (Array.isArray(b.image_urls) && b.image_urls.length) bomImages.set(b.id, b.image_urls);
      bomExtra.set(b.id, {
        prod: b.production_consumption != null && Number(b.production_consumption) > 0 ? Number(b.production_consumption) : null,
        style_no: b.style_no || null,
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
    const key = consolidationKey(identity);
    const net = Number(r.net_purchase_qty) || 0;
    const dev = sl?.qty_per_piece != null ? Number(sl.qty_per_piece) : null;
    const loss = sl?.loss_rate != null ? Number(sl.loss_rate) : null;
    const extra = sl?.bom_id ? bomExtra.get(sl.bom_id) : null;
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
    let g = groups.get(key);
    if (!g) { g = { key, ...identity, total: 0, count: 0, devTop: null, devTopNet: -1, lossTop: null, imgs: [] as string[], reqDate: null, orderBy: null }; groups.set(key, g); }
    g.total += lineTotal; g.count += 1;
    if (net > g.devTopNet) { g.devTopNet = net; g.devTop = dev; g.lossTop = loss; }   // 主导来源的开发单耗/损耗作展示参考
    // 汇集来源图(去重,封顶 8 张)
    const imgs = sl?.bom_id ? (bomImages.get(sl.bom_id) || []) : [];
    for (const u of imgs) if (g.imgs.length < 8 && !g.imgs.includes(u)) g.imgs.push(u);
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
      // 采购没填过损耗 → 预填来源损耗参考(原基线3%),从此损耗只在这一处明算
      const lossRep = ex.procurement_loss_pct ?? g.lossTop;
      const suggested = computeSuggestedPurchaseQty({
        total_required_qty: g.total, development_consumption: devRep,
        production_consumption: ex.production_consumption, procurement_loss_pct: lossRep,
        safety_stock_qty: ex.safety_stock_qty, moq: ex.moq,
      });
      const upd: any = {
        total_required_qty: g.total, source_count: g.count, development_consumption: devRep,
        procurement_loss_pct: lossRep,
        suggested_purchase_qty: suggested, updated_at: now,
      };
      // 图片合并:来源 BOM 新增的图并进去,采购已补拍的保留(union 去重,封顶 8)
      if (g.imgs.length > 0 && 'image_urls' in (ex as any)) {
        const cur: string[] = Array.isArray((ex as any).image_urls) ? (ex as any).image_urls : [];
        const merged = [...cur];
        for (const u of g.imgs) if (merged.length < 8 && !merged.includes(u)) merged.push(u);
        if (merged.length !== cur.length) upd.image_urls = merged;
      }
      // 到货倒推日期刷新(列存在才写,迁移未跑不报错)
      if ('order_by_date' in (ex as any)) { upd.required_date = g.reqDate; upd.order_by_date = g.orderBy; }
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
          const { data: syncedRows } = await (supabase.from('procurement_line_items') as any)
            .update({ ordered_qty: newOrderable, updated_at: now })
            .eq('procurement_item_id', ex.id)
            .in('line_status', ['draft', 'pending_order'])
            .is('purchase_order_id', null)   // 已归到采购单的行不动(改量会弄乱 PO 合计)→ 走 needs_reconfirm
            .select('id');
          syncedLines += ((syncedRows || []) as any[]).length;
        } catch (e: any) { console.warn('[consolidate] 执行行数量同步失败(不阻断):', e?.message); }
      }
    } else {
      seq++;
      const suggested = computeSuggestedPurchaseQty({
        total_required_qty: g.total, development_consumption: g.devTop, procurement_loss_pct: g.lossTop,
      });
      const row: any = {
        order_id: orderId, consolidation_key: g.key,
        item_no: `PI-${orderNo}-${String(seq).padStart(3, '0')}`,
        material_master_id: g.material_master_id, material_name: g.material_name, specification: g.specification,
        category: g.category, color: g.color, unit: g.unit,
        purchase_unit: g.unit,                // 采购计量单位默认=需求单位(物料录入时选过,买法不同采购再改)
        total_required_qty: g.total, source_count: g.count, development_consumption: g.devTop,
        procurement_loss_pct: g.lossTop,      // 预填损耗参考(可见可改;总需求已是裸数,不再暗含)
        suggested_purchase_qty: suggested, status: 'draft', created_by: user.id,
      };
      if (g.imgs.length > 0) row.image_urls = g.imgs;   // 业务传的色卡/辅料图随归并流转
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
    .select('order_id, consolidation_key').eq('id', itemId).single();
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
  if (bomIds.length) {
    const { data: bs } = await (supabase.from('materials_bom') as any).select('id, material_master_id').in('id', bomIds);
    for (const b of (bs || [])) bomMaster.set(b.id, b.material_master_id);
  }

  const sources = (reqs || []).map((r: any) => {
    const sl = r.snapshot_line_id ? slMap.get(r.snapshot_line_id) : null;
    const master_id = sl?.bom_id ? (bomMaster.get(sl.bom_id) || null) : null;
    const key = consolidationKey({
      material_master_id: master_id, material_name: r.material_name || sl?.material_name,
      specification: sl?.specification, category: r.category, color: sl?.color, unit: r.unit,
    });
    return { key, material_name: r.material_name || sl?.material_name, color: sl?.color || null,
      development_consumption: sl?.qty_per_piece ?? null, net_demand: r.net_purchase_qty ?? null };
  }).filter((s: any) => s.key === (item as any).consolidation_key);

  return { data: sources };
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
    .select('total_required_qty, development_consumption').eq('id', itemId).single();
  if (!item) return { error: '采购项不存在' };

  const numFields = ['production_consumption', 'procurement_loss_pct', 'safety_stock_qty', 'final_purchase_qty', 'lead_days', 'moq', 'unit_price', 'tax_rate'];
  const boolFields = ['is_substitute', 'is_split', 'is_outsourced', 'risk_flag', 'price_inclusive_tax'];
  const textFields = ['confirmed_supplier_name', 'backup_supplier_name', 'supplier_contact', 'purchase_unit', 'currency', 'substitute_reason', 'risk_note', 'procurement_notes'];

  const upd: any = { updated_at: new Date().toISOString() };
  for (const k of numFields) if (k in fields) upd[k] = num(fields[k]);
  for (const k of boolFields) if (k in fields) upd[k] = !!fields[k];
  for (const k of textFields) if (k in fields) upd[k] = fields[k] || null;
  if ('quote_date' in fields) upd.quote_date = fields.quote_date || null;

  // 重算 suggested(用新输入)
  upd.suggested_purchase_qty = computeSuggestedPurchaseQty({
    total_required_qty: (item as any).total_required_qty,
    development_consumption: (item as any).development_consumption,
    production_consumption: upd.production_consumption ?? undefined,
    procurement_loss_pct: upd.procurement_loss_pct ?? undefined,
    safety_stock_qty: upd.safety_stock_qty ?? undefined,
    moq: upd.moq ?? undefined,
  });

  const { error } = await (supabase.from('procurement_items') as any).update(upd).eq('id', itemId);
  if (error) return { error: friendlyError(error) };
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

    // 超报价基线闸(P2b):大货单耗>报价单耗 或 采购价>报价单价(容差0)→ 必须先经财务审批。
    try {
      const { data: bi } = await (supabase.from('procurement_items') as any)
        .select('material_name, color, production_consumption, unit_price, baseline_over_status').eq('id', itemId).maybeSingle();
      const { data: cb } = await (supabase.from('order_cost_baseline') as any)
        .select('quote_baseline_lines').eq('order_id', orderId).maybeSingle();
      const baseLines = (((cb as any)?.quote_baseline_lines) || []) as any[];
      if (bi && baseLines.length > 0) {
        const { matchBaseline, checkOverBaseline } = await import('@/lib/domain/cost-baseline');
        const base = matchBaseline(baseLines, (bi as any).material_name, (bi as any).color);
        const chk = base.matched ? checkOverBaseline(base, (bi as any).production_consumption ?? null, (bi as any).unit_price ?? null) : null;
        if (chk && (chk.over_consumption || chk.over_price)) {
          const st = (bi as any).baseline_over_status;
          if (st === 'rejected') return { error: '超报价基线已被财务驳回,不能确认。请调整单耗/供应商价,或让财务重新审批' };
          if (st === 'pending') return { error: '🔴 超报价基线待财务审批,批准后才能确认(财务已收到通知)' };
          if (st !== 'approved') {
            const note = [
              chk.over_consumption ? `大货单耗超报价 +${chk.consumption_over_pct}%` : '',
              chk.over_price ? `采购单价超报价 +${chk.price_over_pct}%` : '',
            ].filter(Boolean).join(' · ');
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
                title: `🔴 超报价基线待审批:${(order as any)?.internal_order_no || (order as any)?.order_no || ''}`,
                message: `「${(bi as any).material_name || ''}${(bi as any).color ? ' · ' + (bi as any).color : ''}」${note}。需财务审批后采购才能确认。`,
                related_order_id: orderId,
              })));
            } catch { /* 通知失败不影响拦截 */ }
            return { error: `🔴 超报价基线(${note}),已自动提交财务审批,批准后才能确认` };
          }
        }
      }
    } catch { /* 基线闸异常不阻断(降级=不拦,避免误锁;审计可查) */ }
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
    .select('id, order_id, consolidation_key, material_name, specification, category, unit, purchase_unit, total_required_qty, suggested_purchase_qty, final_purchase_qty, stock_deduct_qty, order_by_date, required_date, confirmed_supplier_name, unit_price, status')
    .eq('order_id', orderId).eq('status', 'confirmed');
  if (iErr) return { error: friendlyError(iErr) };
  if (!items || items.length === 0) return { error: '无已确认的采购项(请先在采购项上「确认」)' };

  // 已生成过执行行的 item(幂等,不重建)
  const { data: existLines } = await (supabase.from('procurement_line_items') as any)
    .select('procurement_item_id').eq('order_id', orderId).not('procurement_item_id', 'is', null);
  const done = new Set((existLines || []).map((l: any) => l.procurement_item_id));

  const now = new Date().toISOString();
  const rows = (items as any[])
    // 出单量>0 才生成执行行:定案量−库存抵扣=0(全用库存)的项不采购、不发供应商
    .filter((it) => !done.has(it.id) && canGenerateExecution(it) && orderableQty(it) > 0)
    .map((it) => ({ ...buildExecutionLineRow(it, user.id), ordered_at: now }));
  if (rows.length === 0) return { ok: true, created: 0, message: '已确认项无需采购(全用库存抵扣)或均已生成执行行' };

  const { error: insErr } = await (supabase.from('procurement_line_items') as any).insert(rows);
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
