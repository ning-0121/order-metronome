'use server';

/**
 * 采购单（Purchase Order · P1）
 *
 * 一张单 → 一个供应商(suppliers)；行 = procurement_line_items(+purchase_order_id)。
 * 双号：系统自生 po_no + 关联订单 internal_order_no（派生显示）。
 * 底价屏蔽：业务读采购单，server 端剥 unit_price(大货底价)，只回 price_baseline(建议价)。
 * 复用现有 procurement_line_items，不重造。
 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { hasRoleInGroup } from '@/lib/domain/roles';
import { maskFloorForLines, maskSupplierFinance } from '@/lib/procurement/purchaseOrder';
import { fetchLineCostsByIds } from '@/lib/procurement/floorCosts';
import { evaluateProcurementApproval, topRequiredScope, type ApprovalScope } from '@/lib/procurement/approval';
import { syncPurchaseOrderToFinance } from '@/lib/integration/finance-sync';

const CAN_PROCURE = ['admin', 'procurement', 'procurement_manager'];

async function authRoles() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { supabase, roles: [] as string[], userId: undefined };
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles').eq('user_id', user.id).single();
  const roles: string[] =
    (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  return { supabase, roles, userId: user.id };
}

/** 待归单的采购行（未挂采购单）。采购专用（含底价）。 */
export async function listUnassignedProcurementLines(orderId?: string): Promise<{ data?: any[]; error?: string }> {
  const { supabase, roles, userId } = await authRoles();
  if (!userId) return { error: '请先登录' };
  if (!roles.some((r) => CAN_PROCURE.includes(r))) return { error: '仅采购可建采购单' };
  // 采购专用含底价 → 价列已列级封锁,经 service-role 读(本函数已 CAN_PROCURE 门禁)
  let q = (createServiceRoleClient().from('procurement_line_items') as any)
    .select('id, order_id, material_name, specification, category, ordered_qty, ordered_unit, unit_price, price_baseline')
    .is('purchase_order_id', null)
    .order('created_at', { ascending: false });
  if (orderId) q = q.eq('order_id', orderId);
  const { data, error } = await q;
  if (error) return { error: error.message };
  return { data: data || [] };
}

/** 建采购单：选供应商 + 勾采购行 → 头 + 行归单。 */
export async function createPurchaseOrder(input: {
  supplierId: string;
  lineItemIds: string[];
  paymentTerms?: string;
  deliveryDate?: string;
  notes?: string;
  /** C:合并同料 —— 导出给供应商时同 consolidation_key 行并为一行;DB 行不合并(order_id peg 不丢) */
  mergeSameMaterials?: boolean;
}): Promise<{ id?: string; poNo?: string; error?: string }> {
  const { supabase, roles, userId } = await authRoles();
  if (!userId) return { error: '请先登录' };
  if (!roles.some((r) => CAN_PROCURE.includes(r))) return { error: '仅采购可建采购单' };
  if (!input.supplierId) return { error: '请选择供应商' };
  if (!input.lineItemIds?.length) return { error: '请勾选采购行' };

  // 取选中行（校验未被占 + 汇总）——含 ordered_amount(已封锁),经 service-role 读(已 CAN_PROCURE 门禁)
  const { data: lines, error: lErr } = await (createServiceRoleClient().from('procurement_line_items') as any)
    .select('id, order_id, ordered_amount, purchase_order_id')
    .in('id', input.lineItemIds);
  if (lErr) return { error: lErr.message };
  const rows = (lines || []) as any[];
  if (rows.some((r) => r.purchase_order_id)) return { error: '有采购行已在别的采购单里，请刷新重选' };

  const total = rows.reduce((s, r) => s + (Number(r.ordered_amount) || 0), 0);
  const orderIds = [...new Set(rows.map((r) => r.order_id).filter(Boolean))];

  // 生成 po_no PO-YYYYMMDD-NNN
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const { count } = await (supabase.from('purchase_orders') as any)
    .select('id', { count: 'exact', head: true })
    .gte('created_at', new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  const poNo = `PO-${today}-${String((count || 0) + 1).padStart(3, '0')}`;

  const { data: po, error: poErr } = await (supabase.from('purchase_orders') as any)
    .insert({
      po_no: poNo, supplier_id: input.supplierId, order_ids: orderIds, status: 'draft',
      total_amount: total, payment_terms: input.paymentTerms || null,
      delivery_date: input.deliveryDate || null, notes: input.notes || null, created_by: userId,
      merge_same_materials: input.mergeSameMaterials === true,
    })
    .select('id').single();
  if (poErr) return { error: '创建采购单失败：' + poErr.message };

  const poId = (po as any).id;
  // 供应商名同步写到行上(队列显示直读 supplier_name,不再依赖 join)
  const { data: sup } = await (supabase.from('suppliers') as any)
    .select('name').eq('id', input.supplierId).maybeSingle();
  const supplierName = (sup as any)?.name || null;

  // 归行到单（仅未占用的）
  let { error: updErr } = await (supabase.from('procurement_line_items') as any)
    .update({ purchase_order_id: poId, supplier_id: input.supplierId, supplier_name: supplierName })
    .in('id', input.lineItemIds).is('purchase_order_id', null);
  if (updErr && /supplier_id_fkey|foreign key/i.test(updErr.message || '')) {
    // 旧外键仍指 factories(迁移 20260703_supplier_fkey_repoint 未执行)→ 降级:
    // 行上只挂单号+供应商名(供应商真相在采购单头 purchase_orders.supplier_id),先不断业务
    console.warn('[createPurchaseOrder] supplier_id 外键仍指 factories,降级归行。请执行 20260703_supplier_fkey_repoint.sql');
    ({ error: updErr } = await (supabase.from('procurement_line_items') as any)
      .update({ purchase_order_id: poId, supplier_name: supplierName })
      .in('id', input.lineItemIds).is('purchase_order_id', null));
  }
  if (updErr) {
    await (supabase.from('purchase_orders') as any).delete().eq('id', poId); // 回滚头
    return { error: '归行失败：' + updErr.message };
  }

  revalidatePath('/procurement/po');
  return { id: poId, poNo };
}

export async function listPurchaseOrders(): Promise<{ data?: any[]; error?: string }> {
  const { supabase, userId } = await authRoles();
  if (!userId) return { error: '请先登录' };
  const { data, error } = await (supabase.from('purchase_orders') as any)
    .select('id, po_no, supplier_id, status, total_amount, delivery_date, created_at, suppliers(name)')
    .order('created_at', { ascending: false }).limit(100);
  if (error) return { error: error.message };
  return { data: data || [] };
}

/**
 * 某订单关联的采购单档案(2026-07-03:下单后核料页转入追踪模式,这里是"下文"的家)。
 * 每单:PO号/供应商/状态/订购合计/已收/未到,链到采购单详情(批次历史在详情里)。
 */
export async function getOrderPurchaseOrders(orderId: string): Promise<{ data?: any[]; error?: string }> {
  const { supabase, userId } = await authRoles();
  if (!userId) return { error: '请先登录' };
  const { data: lines } = await (supabase.from('procurement_line_items') as any)
    .select('purchase_order_id, ordered_qty, received_qty')
    .eq('order_id', orderId).not('purchase_order_id', 'is', null);
  const poIds = [...new Set((lines || []).map((l: any) => l.purchase_order_id))];
  if (poIds.length === 0) return { data: [] };
  const { data: pos } = await (supabase.from('purchase_orders') as any)
    .select('id, po_no, status, delivery_date, created_at, suppliers(name)').in('id', poIds);
  const agg = new Map<string, { ordered: number; received: number; count: number }>();
  for (const l of (lines || [])) {
    const a = agg.get(l.purchase_order_id) || { ordered: 0, received: 0, count: 0 };
    a.ordered += Number(l.ordered_qty) || 0;
    a.received += Number(l.received_qty) || 0;
    a.count += 1;
    agg.set(l.purchase_order_id, a);
  }
  const out = (pos || []).map((p: any) => {
    const a = agg.get(p.id) || { ordered: 0, received: 0, count: 0 };
    return {
      id: p.id, po_no: p.po_no, status: p.status,
      supplier_name: p.suppliers?.name || null,
      delivery_date: p.delivery_date, created_at: p.created_at,
      line_count: a.count,
      ordered_sum: Math.round(a.ordered * 1000) / 1000,
      received_sum: Math.round(a.received * 1000) / 1000,
      outstanding_sum: Math.max(0, Math.round((a.ordered - a.received) * 1000) / 1000),
    };
  }).sort((x: any, y: any) => String(y.created_at || '').localeCompare(String(x.created_at || '')));
  return { data: out };
}

/** 采购单详情：头 + 供应商 + 行 + 关联订单双号。**底价按角色屏蔽**。 */
export async function getPurchaseOrder(id: string): Promise<{ data?: any; error?: string }> {
  const { supabase, roles, userId } = await authRoles();
  if (!userId) return { error: '请先登录' };

  const { data: po } = await (supabase.from('purchase_orders') as any)
    .select('*, suppliers(*)').eq('id', id).maybeSingle();
  if (!po) return { error: '采购单不存在' };

  // 基础读走用户会话(RLS 管订单范围),不含已封锁的价列(unit_price/ordered_amount);
  // price_baseline(建议价)对业务可见,保留。floor 角色的底价在下方经 service-role 补。
  const { data: lines } = await (supabase.from('procurement_line_items') as any)
    .select('id, order_id, material_name, specification, category, ordered_qty, ordered_unit, price_baseline, received_qty, status, line_status, chase_count, last_chased_at, procurement_item_id')
    .eq('purchase_order_id', id).order('created_at', { ascending: true });

  // 颜色:执行行无 color 列,经 procurement_item_id 回查主数据(采购单按颜色分行,显示必须带色)
  const piIds = [...new Set((lines || []).map((l: any) => l.procurement_item_id).filter(Boolean))];
  if (piIds.length > 0) {
    const { data: pis } = await (supabase.from('procurement_items') as any).select('id, color').in('id', piIds);
    const colorMap = new Map((pis || []).map((p: any) => [p.id, p.color]));
    for (const l of (lines || [])) (l as any).color = l.procurement_item_id ? (colorMap.get(l.procurement_item_id) ?? null) : null;
  }

  // 进度档案(2026-07-03 用户拍板:分批收货后要能追整单全貌)——每行的收货批次历史
  const lineIds = (lines || []).map((l: any) => l.id);
  const receiptsByLine = new Map<string, any[]>();
  if (lineIds.length > 0) {
    const { data: receipts } = await (supabase.from('goods_receipts') as any)
      .select('line_item_id, received_qty, received_unit, received_at, inspection_result, defect_notes')
      .in('line_item_id', lineIds).order('received_at', { ascending: true });
    for (const r of (receipts || [])) {
      const arr = receiptsByLine.get(r.line_item_id) || [];
      arr.push(r); receiptsByLine.set(r.line_item_id, arr);
    }
  }
  for (const l of (lines || [])) (l as any).receipts = receiptsByLine.get((l as any).id) || [];

  // 双号：关联订单的 internal_order_no + order_no
  const orderIds: string[] = ((po as any).order_ids || []) as string[];
  let orderRefs: any[] = [];
  if (orderIds.length > 0) {
    const { data: ords } = await (supabase.from('orders') as any)
      .select('id, order_no, internal_order_no').in('id', orderIds);
    orderRefs = ords || [];
  }

  const canSeeFloor = hasRoleInGroup(roles, 'CAN_SEE_PROCUREMENT_FLOOR');
  // floor 角色 → 经 service-role 把底价/金额补回(基础读已剥离);非 floor 不补
  if (canSeeFloor) {
    const costs = await fetchLineCostsByIds((lines || []).map((l: any) => l.id));
    for (const l of (lines || [])) {
      const c = costs.get((l as any).id);
      if (c) { (l as any).unit_price = c.unit_price; (l as any).ordered_amount = c.ordered_amount; }
    }
  }
  const maskedLines = maskFloorForLines((lines || []) as any[], canSeeFloor);

  const canProcure = roles.some((r) => CAN_PROCURE.includes(r));
  const canApproveProcurement = hasRoleInGroup(roles, 'CAN_APPROVE_PROCUREMENT');
  const canApproveFinance = hasRoleInGroup(roles, 'CAN_APPROVE_PROC_FINANCE');

  // 供应商财务字段(银行/税号/账期)按角色剥离(审计 P0:join 出的 suppliers(*) 此前对全员可读)
  (po as any).suppliers = maskSupplierFinance((po as any).suppliers, hasRoleInGroup(roles, 'CAN_EDIT_SUPPLIER_FINANCE'));

  return { data: { po, lines: maskedLines, orderRefs, canSeeFloor, canProcure, canApproveProcurement, canApproveFinance } };
}

/** 审批采购单（P2a 单签：取最高所需角色）。采购经理 / 财务按 scope 门控。 */
export async function approvePurchaseOrder(poId: string, note?: string): Promise<{ error?: string; ok?: boolean }> {
  const { supabase, roles, userId } = await authRoles();
  if (!userId) return { error: '请先登录' };

  const { data: po } = await (supabase.from('purchase_orders') as any)
    .select('approval_status, approval_required_by').eq('id', poId).maybeSingle();
  if (!po) return { error: '采购单不存在' };
  if ((po as any).approval_status !== 'pending') return { error: '非待审批状态' };

  const scope = topRequiredScope(((po as any).approval_required_by || []) as ApprovalScope[]);
  const authorized = scope === 'finance'
    ? hasRoleInGroup(roles, 'CAN_APPROVE_PROC_FINANCE')
    : hasRoleInGroup(roles, 'CAN_APPROVE_PROCUREMENT');
  if (!authorized) return { error: scope === 'finance' ? '需财务审批权限' : '需采购经理审批权限' };

  const { error } = await (supabase.from('purchase_orders') as any).update({
    approval_status: 'approved', approved_by: userId, approved_at: new Date().toISOString(),
    approval_note: note || null, updated_at: new Date().toISOString(),
  }).eq('id', poId);
  if (error) return { error: error.message };

  revalidatePath(`/procurement/po/${poId}`);
  return { ok: true };
}

/**
 * 下单（P2a）：draft → placed。**始终跑风险闸**（无法绕过审批）。
 * 已 approved → 直接下单;否则评估:有风险 → 转 pending 并阻断;无风险 → 直接下单。
 */
export async function placePurchaseOrder(poId: string): Promise<{
  error?: string; ok?: boolean; pendingApproval?: boolean; reasons?: string[];
}> {
  const { supabase, roles, userId } = await authRoles();
  if (!userId) return { error: '请先登录' };
  if (!roles.some((r) => CAN_PROCURE.includes(r))) return { error: '无采购权限' };

  const { data: po } = await (supabase.from('purchase_orders') as any)
    .select('status, approval_status, total_amount, supplier_id, order_proof_paths, suppliers(net_days)').eq('id', poId).maybeSingle();
  if (!po) return { error: '采购单不存在' };
  if ((po as any).status !== 'draft') return { error: '仅草稿可下单' };

  // 下单强制凭证(2026-07-04 用户拍板):没上传下单凭证不允许下单。列缺失时不卡(迁移前兼容)。
  if ('order_proof_paths' in (po as any)) {
    const proofs = (po as any).order_proof_paths;
    if (!Array.isArray(proofs) || proofs.length === 0) {
      return { error: '下单前必须上传下单凭证(给供应商的下单截图/付款凭证/回单等)。请在采购单页「下单凭证」处上传后再下单。' };
    }
  }

  const place = async () => {
    const { error } = await (supabase.from('purchase_orders') as any)
      .update({ status: 'placed', updated_at: new Date().toISOString() }).eq('id', poId);
    if (error) { revalidatePath(`/procurement/po/${poId}`); return { error: error.message }; }
    // R3:该单的行 draft/pending_order → ordered,进「待催货」队列(失败不阻断下单)
    try {
      await (supabase.from('procurement_line_items') as any)
        .update({ line_status: 'ordered' })
        .eq('purchase_order_id', poId)
        .in('line_status', ['draft', 'pending_order']);
    } catch (e: any) { console.warn('[placePurchaseOrder] 行状态推进失败(不阻断):', e?.message); }
    // P2b: placed → 财务同步（应付/付款计划）。未配置即跳过，绝不阻塞下单。
    // 2026-07-03:附带补采购预警——此单执行行若挂了补采购项,财务侧收到 has_supplement + 明细
    try {
      const { data: full } = await (supabase.from('purchase_orders') as any).select('*').eq('id', poId).maybeSingle();
      if (full) {
        let supplements: Array<{ item_no?: string; material_name?: string; qty?: number; reason?: string }> = [];
        try {
          const { data: lines } = await (supabase.from('procurement_line_items') as any)
            .select('procurement_item_id').eq('purchase_order_id', poId).not('procurement_item_id', 'is', null);
          const piIds = [...new Set((lines || []).map((l: any) => l.procurement_item_id))];
          if (piIds.length > 0) {
            const { data: suppItems } = await (supabase.from('procurement_items') as any)
              .select('item_no, material_name, total_required_qty, supplement_reason')
              .in('id', piIds).eq('is_supplement', true);
            supplements = (suppItems || []).map((s: any) => ({
              item_no: s.item_no, material_name: s.material_name,
              qty: s.total_required_qty, reason: s.supplement_reason,
            }));
          }
        } catch { /* 补采购列未建时静默(迁移前) */ }
        await syncPurchaseOrderToFinance(full, undefined, supplements);
      }
    } catch { /* 财务同步失败不影响下单 */ }
    // B3a: placed → 关联采购项 confirmed→ordered(fire-and-forget)。
    try {
      const { syncProcurementItemsOrderedForPO } = await import('@/app/actions/procurement-items');
      await syncProcurementItemsOrderedForPO(poId);
    } catch (e: any) { console.warn('[placePurchaseOrder] 采购项状态联动失败(不阻断下单):', e?.message); }
    // 全部采购项已下单 → 自动完成「采购下单」节点,「待采购订单」卡随之消失(2026-07-03)
    try {
      const { autoCompleteProcurementPlacedForPO } = await import('@/app/actions/procurement-items');
      await autoCompleteProcurementPlacedForPO(poId);
    } catch (e: any) { console.warn('[placePurchaseOrder] 采购下单节点自动完成失败(不阻断):', e?.message); }
    revalidatePath(`/procurement/po/${poId}`);
    return { ok: true };
  };

  // 已审批通过 → 直接下单
  if ((po as any).approval_status === 'approved') return place();

  // 否则跑风险闸（无法绕过）——读底价评估,经 service-role(已 CAN_PROCURE 门禁)
  const { data: lines } = await (createServiceRoleClient().from('procurement_line_items') as any)
    .select('unit_price, price_baseline').eq('purchase_order_id', poId);
  const { count } = await (supabase.from('purchase_orders') as any)
    .select('id', { count: 'exact', head: true })
    .eq('supplier_id', (po as any).supplier_id).neq('id', poId)
    .in('status', ['placed', 'confirmed', 'receiving', 'received', 'closed']);

  const decision = evaluateProcurementApproval({
    totalAmount: (po as any).total_amount ?? 0,
    lines: (lines || []) as any[],
    supplierNetDays: (po as any).suppliers?.net_days ?? null,
    isNewSupplier: (count || 0) === 0,
    orderBudget: null,
  });

  if (decision.needsApproval) {
    await (supabase.from('purchase_orders') as any).update({
      approval_status: 'pending', approval_required_by: decision.requiredBy,
      approval_reasons: decision.reasons, updated_at: new Date().toISOString(),
    }).eq('id', poId);
    // 通知审批人:采购单卡在待审批 —— 否则采购/财务不知道要审,单子石沉大海(2026-07-04 用户反馈)
    try {
      const notifyRoles = new Set<string>(['admin']);
      if (decision.requiredBy.includes('finance')) notifyRoles.add('finance');
      if (decision.requiredBy.includes('procurement')) notifyRoles.add('procurement_manager');
      const scopeCn = decision.requiredBy.includes('finance') ? '财务' : '采购经理';
      const { notifyUsersByRole } = await import('@/lib/utils/notifications');
      await notifyUsersByRole(supabase, [...notifyRoles], {
        type: 'po_approval',
        title: `🟠 采购单待审批：${(po as any).po_no || ''}`,
        message: `采购单 ${(po as any).po_no || poId} 触发风险闸（${decision.reasons.join('、')}），需${scopeCn}审批后方可下单。请到采购单页审批。`,
      });
    } catch (e: any) { console.warn('[placePurchaseOrder] 待审批通知失败(不阻断):', e?.message); }
    revalidatePath(`/procurement/po/${poId}`);
    return { pendingApproval: true, reasons: decision.reasons };
  }

  await (supabase.from('purchase_orders') as any)
    .update({ approval_status: 'not_required', updated_at: new Date().toISOString() }).eq('id', poId);
  return place();
}

/** 保存下单凭证路径(order-docs 私有桶,客户端已上传)。下单前必须 ≥1 张。 */
export async function savePurchaseOrderProof(poId: string, paths: string[]): Promise<{ ok?: boolean; error?: string }> {
  const { supabase, roles, userId } = await authRoles();
  if (!userId) return { error: '请先登录' };
  if (!roles.some((r) => CAN_PROCURE.includes(r))) return { error: '无采购权限' };
  const clean = (paths || []).filter((p) => typeof p === 'string' && p.trim());
  const { error } = await (supabase.from('purchase_orders') as any)
    .update({ order_proof_paths: clean, updated_at: new Date().toISOString() }).eq('id', poId);
  if (error) {
    if (/order_proof_paths|does not exist|column/i.test(error.message)) return { error: '凭证列尚未创建,请先在 Supabase 执行 20260704_po_order_proof.sql' };
    return { error: error.message };
  }
  revalidatePath(`/procurement/po/${poId}`);
  return { ok: true };
}

/** 导出采购单 Excel（发供应商；采购专用，含底价）。 */
export async function exportPurchaseOrder(id: string, opts: { withPrice?: boolean } = {}): Promise<{ base64?: string; fileName?: string; error?: string }> {
  const withPrice = opts.withPrice !== false;   // 默认含价(发供应商);false = 无价版(内部流转:业务/生产/仓库)
  const { supabase, roles, userId } = await authRoles();
  if (!userId) return { error: '请先登录' };
  // 含价版仅采购可导;无价版无敏感价格,任何登录用户可导(供发内部群/生产跟单/仓库收货核对)
  if (withPrice && !roles.some((r) => CAN_PROCURE.includes(r))) return { error: '仅采购可导出含价采购单' };

  const { data: po } = await (supabase.from('purchase_orders') as any)
    .select('*, suppliers(*)').eq('id', id).maybeSingle();
  if (!po) return { error: '采购单不存在' };
  // 含价版(仅采购)经 service-role 读底价;无价版走用户会话(RLS 管范围),不取价列
  const { data: lines } = await ((withPrice ? createServiceRoleClient() : supabase).from('procurement_line_items') as any)
    .select(withPrice
      ? 'material_name, specification, category, ordered_qty, ordered_unit, unit_price, ordered_amount, notes, procurement_item_id'
      : 'material_name, specification, category, ordered_qty, ordered_unit, notes, procurement_item_id')
    .eq('purchase_order_id', id).order('created_at', { ascending: true });

  // 颜色 + 大货单耗:执行行无这些列 → 经 procurement_item_id 回查主数据(采购单按颜色分行,模板需要)
  const piIds = [...new Set((lines || []).map((l: any) => l.procurement_item_id).filter(Boolean))];
  const piMap = new Map<string, any>();
  if (piIds.length > 0) {
    const { data: pis } = await (createServiceRoleClient().from('procurement_items') as any)
      .select('id, color, production_consumption, development_consumption').in('id', piIds);
    for (const p of (pis || [])) piMap.set(p.id, p);
  }
  for (const l of (lines || [])) {
    const pi = l.procurement_item_id ? piMap.get(l.procurement_item_id) : null;
    (l as any).color = pi?.color ?? null;
    (l as any).consumption = pi?.production_consumption ?? pi?.development_consumption ?? null;
  }

  const { data: ords } = await (supabase.from('orders') as any)
    .select('order_no, internal_order_no, customer_name').in('id', ((po as any).order_ids || []) as string[]);

  // 采购单模板按「物料 + 颜色 + 规格 + 单位」聚合成行(颜色分行,同色跨订单求和);DB 行不动。
  const rowMap = new Map<string, any>();
  for (const l of (lines || []) as any[]) {
    const key = `${l.material_name || ''}|${l.color || ''}|${l.specification || ''}|${l.ordered_unit || ''}`;
    const g = rowMap.get(key) || {
      material_name: l.material_name || '', color: l.color || '', specification: l.specification || '',
      unit: l.ordered_unit || '', consumption: l.consumption ?? null, notes: l.notes || '',
      qty: 0, amount: 0, prices: new Set<number>(),
    };
    g.qty += Number(l.ordered_qty) || 0;
    g.amount += Number(l.ordered_amount) || 0;
    if (l.unit_price != null) g.prices.add(Number(l.unit_price));
    rowMap.set(key, g);
  }
  const rows = [...rowMap.values()].map((g) => ({
    ...g,
    unit_price: g.prices.size === 1 ? [...g.prices][0] : (g.qty > 0 && g.amount ? Math.round((g.amount / g.qty) * 10000) / 10000 : null),
  }));
  const materials = [...new Set(rows.map((r) => r.material_name).filter(Boolean))];
  const multiMaterial = materials.length > 1;

  const sup = (po as any).suppliers || {};
  const orderNos = (ords || []).map((o: any) => o.internal_order_no || o.order_no).filter(Boolean).join(' / ') || (po as any).po_no || '';

  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.default.Workbook();
  wb.creator = 'QIMO OS · 义乌市绮陌服饰有限公司';
  const ws = wb.addWorksheet('采购单');

  // 列定义(按你上传的模板);无价版去掉 单价/金额
  const COLS: Array<{ h: string; w: number; price?: boolean }> = [
    ...(multiMaterial ? [{ h: '原辅料名', w: 20 }] : []),
    { h: '颜色代码', w: 16 }, { h: 'PATTON色号', w: 12 }, { h: '工厂色号', w: 12 },
    { h: '单件平方用量', w: 12 }, { h: '单件用量(kg)', w: 12 }, { h: '订单数量', w: 10 },
    { h: '总用量', w: 12 }, { h: '单位', w: 8 },
    ...(withPrice ? [{ h: '单价', w: 10, price: true }, { h: '金额', w: 14, price: true }] : []),
    { h: '备注', w: 20 },
  ];
  const NC = COLS.length;
  const colLetter = (i: number) => String.fromCharCode(65 + i);
  const lastCol = colLetter(NC - 1);

  // 抬头:公司名 + 采购单
  ws.mergeCells(`A1:${lastCol}1`);
  ws.getCell('A1').value = '义乌市绮陌服饰有限公司  ·  采购单 PURCHASE ORDER' + (withPrice ? '' : '(内部流转·无价)');
  ws.getCell('A1').font = { bold: true, size: 14 };
  ws.getCell('A1').alignment = { horizontal: 'center' };
  ws.getRow(1).height = 24;
  // 抬头信息块
  ws.addRow([]);
  // 采购单发供应商,不暴露客户名(2026-07-04 用户拍板)
  ws.addRow(['订单号', orderNos, '原辅料名', multiMaterial ? materials.join('、') : (materials[0] || '')]);
  ws.addRow(['供应商', sup.name || '—', '联系人/电话', `${sup.contact_name || ''} ${sup.phone || ''}`.trim() || '—', '预计到货', (po as any).delivery_date || '—']);
  if (withPrice) ws.addRow(['付款方式/账期', `${sup.payment_method || '—'} / ${sup.net_days != null ? sup.net_days + '天' : '—'}`]);
  ws.addRow([]);

  // 表头
  const headerRow = ws.addRow(COLS.map((c) => c.h));
  headerRow.eachCell((cell) => {
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF1F5' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
  });

  // 明细行(每颜色一行;PATTON色号/工厂色号/单件平方用量/订单数量 无数据留空给采购员手填)
  let totalAmount = 0;
  for (const r of rows) {
    const cells: any[] = [
      ...(multiMaterial ? [r.material_name] : []),
      r.color || '', '', '', '',                       // 颜色 · PATTON · 工厂色号 · 单件平方用量(空)
      r.consumption ?? '', '',                          // 单件用量kg · 订单数量(空)
      Math.round(r.qty * 1000) / 1000, r.unit || '',    // 总用量 · 单位
      ...(withPrice ? [r.unit_price ?? '', r.amount ? Math.round(r.amount * 100) / 100 : ''] : []),
      r.notes || '',
    ];
    if (withPrice && r.amount) totalAmount += r.amount;
    const row = ws.addRow(cells);
    row.eachCell((cell) => { cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } }; });
  }

  // 合计(含价版)
  if (withPrice) {
    const totalRow = ws.addRow([]);
    const amtColIdx = COLS.findIndex((c) => c.h === '金额');
    ws.getCell(`${colLetter(amtColIdx - 1)}${totalRow.number}`).value = '合计';
    ws.getCell(`${colLetter(amtColIdx - 1)}${totalRow.number}`).font = { bold: true };
    ws.getCell(`${colLetter(amtColIdx)}${totalRow.number}`).value = Math.round(totalAmount * 100) / 100;
    ws.getCell(`${colLetter(amtColIdx)}${totalRow.number}`).font = { bold: true };
  }

  // 页脚
  ws.addRow([]);
  ws.addRow(['业务员：', '', '采购员：', '', '下单日期：', new Date().toLocaleDateString('zh-CN')]);

  COLS.forEach((c, i) => { ws.getColumn(i + 1).width = c.w; });

  const base64 = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
  return { base64, fileName: `采购单${withPrice ? '' : '_无价版'}_${(po as any).po_no}_${sup.name || ''}.xlsx` };
}
