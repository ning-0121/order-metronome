'use server';

/**
 * 采购单（Purchase Order · P1）
 *
 * 一张单 → 一个供应商(suppliers)；行 = procurement_line_items(+purchase_order_id)。
 * 双号：系统自生 po_no + 关联订单 internal_order_no（派生显示）。
 * 底价屏蔽：业务读采购单，server 端剥 unit_price(大货底价)，只回 price_baseline(建议价)。
 * 复用现有 procurement_line_items，不重造。
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { hasRoleInGroup } from '@/lib/domain/roles';
import { maskFloorForLines } from '@/lib/procurement/purchaseOrder';
import { evaluateProcurementApproval, topRequiredScope, type ApprovalScope } from '@/lib/procurement/approval';
import { syncPurchaseOrderToFinance } from '@/lib/integration/finance-sync';
import { consolidationKey } from '@/lib/services/procurement-consolidation';

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
  let q = (supabase.from('procurement_line_items') as any)
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

  // 取选中行（校验未被占 + 汇总）
  const { data: lines, error: lErr } = await (supabase.from('procurement_line_items') as any)
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
  // 归行到单（仅未占用的）
  const { error: updErr } = await (supabase.from('procurement_line_items') as any)
    .update({ purchase_order_id: poId, supplier_id: input.supplierId })
    .in('id', input.lineItemIds).is('purchase_order_id', null);
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

/** 采购单详情：头 + 供应商 + 行 + 关联订单双号。**底价按角色屏蔽**。 */
export async function getPurchaseOrder(id: string): Promise<{ data?: any; error?: string }> {
  const { supabase, roles, userId } = await authRoles();
  if (!userId) return { error: '请先登录' };

  const { data: po } = await (supabase.from('purchase_orders') as any)
    .select('*, suppliers(*)').eq('id', id).maybeSingle();
  if (!po) return { error: '采购单不存在' };

  const { data: lines } = await (supabase.from('procurement_line_items') as any)
    .select('id, order_id, material_name, specification, category, ordered_qty, ordered_unit, unit_price, price_baseline, ordered_amount, received_qty, status')
    .eq('purchase_order_id', id).order('created_at', { ascending: true });

  // 双号：关联订单的 internal_order_no + order_no
  const orderIds: string[] = ((po as any).order_ids || []) as string[];
  let orderRefs: any[] = [];
  if (orderIds.length > 0) {
    const { data: ords } = await (supabase.from('orders') as any)
      .select('id, order_no, internal_order_no').in('id', orderIds);
    orderRefs = ords || [];
  }

  const canSeeFloor = hasRoleInGroup(roles, 'CAN_SEE_PROCUREMENT_FLOOR');
  const maskedLines = maskFloorForLines((lines || []) as any[], canSeeFloor);

  const canProcure = roles.some((r) => CAN_PROCURE.includes(r));
  const canApproveProcurement = hasRoleInGroup(roles, 'CAN_APPROVE_PROCUREMENT');
  const canApproveFinance = hasRoleInGroup(roles, 'CAN_APPROVE_PROC_FINANCE');

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
    .select('status, approval_status, total_amount, supplier_id, suppliers(net_days)').eq('id', poId).maybeSingle();
  if (!po) return { error: '采购单不存在' };
  if ((po as any).status !== 'draft') return { error: '仅草稿可下单' };

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
    revalidatePath(`/procurement/po/${poId}`);
    return { ok: true };
  };

  // 已审批通过 → 直接下单
  if ((po as any).approval_status === 'approved') return place();

  // 否则跑风险闸（无法绕过）
  const { data: lines } = await (supabase.from('procurement_line_items') as any)
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
    revalidatePath(`/procurement/po/${poId}`);
    return { pendingApproval: true, reasons: decision.reasons };
  }

  await (supabase.from('purchase_orders') as any)
    .update({ approval_status: 'not_required', updated_at: new Date().toISOString() }).eq('id', poId);
  return place();
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
  const { data: lines } = await (supabase.from('procurement_line_items') as any)
    .select('material_name, specification, category, ordered_qty, ordered_unit, unit_price, ordered_amount')
    .eq('purchase_order_id', id).order('created_at', { ascending: true });
  const { data: ords } = await (supabase.from('orders') as any)
    .select('order_no, internal_order_no').in('id', ((po as any).order_ids || []) as string[]);

  // C 合并同料:同 consolidation_key 并为一行(数量/金额求和;单价不一致时按 金额/数量 回算)。只影响导出,DB 行不动。
  let exportLines = (lines || []) as any[];
  if ((po as any).merge_same_materials) {
    const groups = new Map<string, any>();
    for (const l of exportLines) {
      const key = consolidationKey({
        material_name: l.material_name, specification: l.specification,
        category: l.category, unit: l.ordered_unit,
      });
      const g = groups.get(key);
      if (!g) { groups.set(key, { ...l, _prices: new Set([l.unit_price ?? null]) }); continue; }
      g.ordered_qty = (Number(g.ordered_qty) || 0) + (Number(l.ordered_qty) || 0);
      g.ordered_amount = (Number(g.ordered_amount) || 0) + (Number(l.ordered_amount) || 0);
      g._prices.add(l.unit_price ?? null);
    }
    exportLines = [...groups.values()].map((g) => {
      if (g._prices.size > 1) {
        const qty = Number(g.ordered_qty) || 0;
        g.unit_price = qty > 0 && g.ordered_amount != null ? Math.round((g.ordered_amount / qty) * 10000) / 10000 : null;
      }
      delete g._prices;
      return g;
    });
  }

  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.default.Workbook();
  const ws = wb.addWorksheet('采购单');
  const sup = (po as any).suppliers || {};
  const dualNo = `${(po as any).po_no}  ·  订单 ${(ords || []).map((o: any) => o.internal_order_no || o.order_no).join(' / ') || '—'}`;
  ws.addRow([withPrice ? '采购单 PURCHASE ORDER' : '采购单(内部流转 · 无价)']);
  ws.addRow(['单号', dualNo]);
  ws.addRow(['供应商', sup.name || '—']);
  ws.addRow(['联系人/电话', `${sup.contact_name || ''} ${sup.phone || ''}`]);
  if (withPrice) ws.addRow(['付款方式/账期', `${sup.payment_method || '—'} / ${sup.net_days != null ? sup.net_days + '天' : '—'}`]);
  ws.addRow(['交期', (po as any).delivery_date || '—']);
  ws.addRow([]);
  if (withPrice) {
    ws.addRow(['物料', '规格', '数量', '单位', '单价', '金额']);
    for (const l of exportLines) {
      ws.addRow([l.material_name, l.specification || '', l.ordered_qty, l.ordered_unit, l.unit_price ?? '', l.ordered_amount ?? '']);
    }
    ws.addRow([]);
    ws.addRow(['', '', '', '', '合计', (po as any).total_amount ?? '']);
    [22, 22, 12, 8, 12, 14].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  } else {
    // 无价版:去掉单价/金额/合计/账期,加收货栏(仓库到货核对手填)
    ws.addRow(['物料', '规格', '数量', '单位', '实收数量', '备注']);
    for (const l of exportLines) {
      ws.addRow([l.material_name, l.specification || '', l.ordered_qty, l.ordered_unit, '', '']);
    }
    [22, 22, 12, 8, 12, 18].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  }

  const base64 = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
  return { base64, fileName: `采购单${withPrice ? '' : '_无价版'}_${(po as any).po_no}_${sup.name || ''}.xlsx` };
}
