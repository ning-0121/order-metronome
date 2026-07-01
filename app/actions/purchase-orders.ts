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

  return { data: { po, lines: maskedLines, orderRefs, canSeeFloor } };
}

/** 导出采购单 Excel（发供应商；采购专用，含底价）。 */
export async function exportPurchaseOrder(id: string): Promise<{ base64?: string; fileName?: string; error?: string }> {
  const { supabase, roles, userId } = await authRoles();
  if (!userId) return { error: '请先登录' };
  if (!roles.some((r) => CAN_PROCURE.includes(r))) return { error: '仅采购可导出采购单' };

  const { data: po } = await (supabase.from('purchase_orders') as any)
    .select('*, suppliers(*)').eq('id', id).maybeSingle();
  if (!po) return { error: '采购单不存在' };
  const { data: lines } = await (supabase.from('procurement_line_items') as any)
    .select('material_name, specification, ordered_qty, ordered_unit, unit_price, ordered_amount')
    .eq('purchase_order_id', id).order('created_at', { ascending: true });
  const { data: ords } = await (supabase.from('orders') as any)
    .select('order_no, internal_order_no').in('id', ((po as any).order_ids || []) as string[]);

  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.default.Workbook();
  const ws = wb.addWorksheet('采购单');
  const sup = (po as any).suppliers || {};
  const dualNo = `${(po as any).po_no}  ·  订单 ${(ords || []).map((o: any) => o.internal_order_no || o.order_no).join(' / ') || '—'}`;
  ws.addRow(['采购单 PURCHASE ORDER']);
  ws.addRow(['单号', dualNo]);
  ws.addRow(['供应商', sup.name || '—']);
  ws.addRow(['联系人/电话', `${sup.contact_name || ''} ${sup.phone || ''}`]);
  ws.addRow(['付款方式/账期', `${sup.payment_method || '—'} / ${sup.net_days != null ? sup.net_days + '天' : '—'}`]);
  ws.addRow(['交期', (po as any).delivery_date || '—']);
  ws.addRow([]);
  ws.addRow(['物料', '规格', '数量', '单位', '单价', '金额']);
  for (const l of (lines || []) as any[]) {
    ws.addRow([l.material_name, l.specification || '', l.ordered_qty, l.ordered_unit, l.unit_price ?? '', l.ordered_amount ?? '']);
  }
  ws.addRow([]);
  ws.addRow(['', '', '', '', '合计', (po as any).total_amount ?? '']);
  [22, 22, 12, 8, 12, 14].forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  const base64 = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
  return { base64, fileName: `采购单_${(po as any).po_no}_${sup.name || ''}.xlsx` };
}
