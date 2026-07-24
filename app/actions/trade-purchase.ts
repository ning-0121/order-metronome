'use server';

/**
 * 经销单「大货采购单」(2026-07-26)
 * 经销单(order_purpose='trade')买成品、无原辅料 → 采购核料 tab 隐藏。
 * 这里把成品款(order_line_items 的进价 purchase_unit_cost)物化成"成品大货"采购行
 * (category='成品大货', procurement_item_id=null,绕开原辅料专属逻辑),复用现有:
 *   业务建草稿 → 采购 placePurchaseOrder 下达 → 财务前置审批 → 建应付/付款计划(零改动)。
 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { listSuppliers } from '@/app/actions/suppliers';
import { savePurchaseOrderProof } from '@/app/actions/purchase-orders';

const CAN_CREATE = ['admin', 'sales', 'merchandiser', 'procurement', 'procurement_manager']; // 业务建
const CAN_PLACE = ['admin', 'procurement', 'procurement_manager'];                            // 采购下达
const TRADE_BULK_CATEGORY = '成品大货';

async function auth() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { supabase, user: null, roles: [] as string[] };
  const { data: p } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (p?.roles?.length > 0 ? p.roles : [p?.role].filter(Boolean)) as string[];
  return { supabase, user, roles };
}

export interface TradeBulkLine { style_no: string | null; color: string | null; qty: number; purchase_unit_cost: number | null; sale_unit_price: number | null; }

/** 经销单大货采购面板数据:成品款行 + 已建大货采购单 + 供应商 + 权限。 */
export async function getTradeBulkData(orderId: string): Promise<{
  isTrade?: boolean; lines?: TradeBulkLine[]; pos?: any[]; suppliers?: any[];
  canCreate?: boolean; canPlace?: boolean; costTotal?: number; error?: string;
}> {
  const { supabase, user, roles } = await auth();
  if (!user) return { error: '请先登录' };

  const { data: order } = await (supabase.from('orders') as any)
    .select('id, order_purpose').eq('id', orderId).maybeSingle();
  if (!order) return { error: '订单不存在' };
  if ((order as any).order_purpose !== 'trade') return { isTrade: false };

  const { data: liRows } = await (supabase.from('order_line_items') as any)
    .select('style_no, color, qty_pcs, purchase_unit_cost, po_unit_price').eq('order_id', orderId);
  const lines: TradeBulkLine[] = ((liRows || []) as any[]).map((l) => ({
    style_no: l.style_no ?? null,
    color: l.color ?? null,
    qty: Number(l.qty_pcs) || 0,
    purchase_unit_cost: l.purchase_unit_cost != null ? Number(l.purchase_unit_cost) : null,
    sale_unit_price: l.po_unit_price != null ? Number(l.po_unit_price) : null,
  }));
  const costTotal = Math.round(lines.reduce((s, l) => s + (l.purchase_unit_cost || 0) * l.qty, 0) * 100) / 100;

  // 直查本单大货采购单(含 total_amount/approval_status/凭证);service-role 读(已鉴权+角色门禁)
  const svc = createServiceRoleClient();
  const { data: pos } = await (svc.from('purchase_orders') as any)
    .select('id, po_no, status, approval_status, total_amount, order_proof_paths, supplier_id, suppliers(name)')
    .contains('order_ids', [orderId]).order('created_at', { ascending: false });
  const posOut = ((pos || []) as any[]).map((p) => ({ ...p, supplier_name: p.suppliers?.name || null }));
  const suppliers = roles.some((r) => CAN_CREATE.includes(r)) ? (await listSuppliers()).data || [] : [];

  return {
    isTrade: true, lines, costTotal,
    pos: posOut,
    suppliers,
    canCreate: roles.some((r) => CAN_CREATE.includes(r)),
    canPlace: roles.some((r) => CAN_PLACE.includes(r)),
  };
}

/** 业务建大货采购单草稿:成品款→成品大货采购行 + 采购单(draft)。下达由采购走 placePurchaseOrder。 */
export async function createTradeBulkPurchaseOrder(orderId: string, input: {
  supplierId: string; paymentTerms?: string; deliveryDate?: string;
}): Promise<{ poId?: string; poNo?: string; error?: string }> {
  const { supabase, user, roles } = await auth();
  if (!user) return { error: '请先登录' };
  if (!roles.some((r) => CAN_CREATE.includes(r))) return { error: '仅业务/采购/管理员可建大货采购单' };
  if (!input.supplierId) return { error: '请选择供应商' };

  const { data: order } = await (supabase.from('orders') as any)
    .select('id, order_purpose, order_no, internal_order_no').eq('id', orderId).maybeSingle();
  if (!order) return { error: '订单不存在' };
  if ((order as any).order_purpose !== 'trade') return { error: '仅经销单可建大货采购单' };

  const svc = createServiceRoleClient();

  // 防重:本单已有未作废的大货采购单 → 不再重复建(避免同一批成品重复采购/重复应付)
  const { data: existPos } = await (svc.from('purchase_orders') as any)
    .select('id, po_no, status').contains('order_ids', [orderId]);
  const activeExist = ((existPos || []) as any[]).some((p) => p.status !== 'cancelled');
  if (activeExist) return { error: '本单已有大货采购单(如需拆供应商/改单,请先作废原单再建)' };

  // 读成品款(进价>0、数量>0 才入采购)
  const { data: liRows } = await (svc.from('order_line_items') as any)
    .select('style_no, color, qty_pcs, purchase_unit_cost').eq('order_id', orderId);
  const buyable = ((liRows || []) as any[])
    .map((l) => ({ style_no: l.style_no || '成品', color: l.color || null, qty: Number(l.qty_pcs) || 0, cost: l.purchase_unit_cost != null ? Number(l.purchase_unit_cost) : 0 }))
    .filter((l) => l.qty > 0 && l.cost > 0);
  if (buyable.length === 0) return { error: '没有可采购的成品款:请先在订单逐款录入采购进价(purchase_unit_cost)和数量' };

  // 供应商名(冗余上行,队列直读)
  const { data: sup } = await (svc.from('suppliers') as any).select('name').eq('id', input.supplierId).maybeSingle();
  const supplierName = (sup as any)?.name || null;

  // 1) 物化成品大货采购行(procurement_item_id=null → 绕开原辅料 needs_reconfirm/布料折叠)
  const lineRows = buyable.map((l) => ({
    order_id: orderId,
    material_name: `${l.style_no}${l.color ? `·${l.color}` : ''} (成品大货)`,
    category: TRADE_BULK_CATEGORY,
    ordered_qty: l.qty,
    ordered_unit: '件',
    unit_price: l.cost,       // ordered_amount = qty×unit_price 由 DB 生成列自动算
    line_status: 'active',
    procurement_item_id: null,
    supplier_name: supplierName,
    supplier_id: input.supplierId,
  }));
  let { data: insertedLines, error: liErr } = await (svc.from('procurement_line_items') as any).insert(lineRows).select('id, ordered_amount');
  // supplier_id 外键旧指 factories 时降级:去掉 supplier_id 重试(供应商真相在采购单头)
  if (liErr && /supplier_id_fkey|foreign key/i.test(liErr.message || '')) {
    const degraded = lineRows.map(({ supplier_id, ...rest }) => rest);
    ({ data: insertedLines, error: liErr } = await (svc.from('procurement_line_items') as any).insert(degraded).select('id, ordered_amount'));
  }
  if (liErr) return { error: '生成大货采购行失败:' + liErr.message };
  const lineIds = ((insertedLines || []) as any[]).map((r) => r.id);
  const total = Math.round(((insertedLines || []) as any[]).reduce((s, r) => s + (Number(r.ordered_amount) || 0), 0) * 100) / 100;

  // 2) 建采购单(draft),po_no = PO-YYYYMMDD-NNN(取当天最大序号+1,冲突自增重试)
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const poPrefix = `PO-${today}-`;
  const nextSeq = async (bump: number): Promise<string> => {
    const { data: ex } = await (svc.from('purchase_orders') as any).select('po_no').like('po_no', `${poPrefix}%`);
    let maxN = 0;
    for (const r of (ex || []) as any[]) { const m = /-(\d+)$/.exec(String(r.po_no || '')); if (m) maxN = Math.max(maxN, parseInt(m[1], 10)); }
    return `${poPrefix}${String(maxN + 1 + bump).padStart(3, '0')}`;
  };
  let po: any = null, poErr: any = null, poNo = '';
  for (let attempt = 0; attempt < 6; attempt++) {
    poNo = await nextSeq(attempt);
    const res = await (svc.from('purchase_orders') as any).insert({
      po_no: poNo, supplier_id: input.supplierId, order_ids: [orderId], status: 'draft',
      total_amount: total, payment_terms: input.paymentTerms || null,
      delivery_date: input.deliveryDate || null, created_by: user.id,
      notes: '经销单大货采购(成品)',
    }).select('id').single();
    po = res.data; poErr = res.error;
    if (!poErr) break;
    if (!/po_no_key|duplicate key/i.test(poErr.message || '')) break;
  }
  if (poErr) {
    // 采购单建失败 → 回滚刚建的采购行,避免留孤儿
    await (svc.from('procurement_line_items') as any).delete().in('id', lineIds);
    return { error: '建大货采购单失败:' + poErr.message };
  }
  const poId = (po as any).id;

  // 3) 归行到单
  await (svc.from('procurement_line_items') as any)
    .update({ purchase_order_id: poId }).in('id', lineIds);

  revalidatePath(`/orders/${orderId}`);
  return { poId, poNo };
}

/** 上传大货采购单的下单凭证(给供应商的下单截图/回单),下达前必传。base64 上传到 order-docs → 存路径。 */
export async function uploadTradePoProof(orderId: string, poId: string, fileBase64: string, fileName: string): Promise<{ ok?: boolean; error?: string }> {
  const { supabase, user, roles } = await auth();
  if (!user) return { error: '请先登录' };
  if (!roles.some((r) => CAN_PLACE.includes(r) || CAN_CREATE.includes(r))) return { error: '无权上传凭证' };
  try {
    const ext = (fileName.split('.').pop() || 'bin').toLowerCase();
    const path = `${orderId}/trade-po/${poId}_${Date.now()}.${ext}`;
    const bin = Buffer.from(fileBase64.replace(/^data:[^;]+;base64,/, ''), 'base64');
    const { error: upErr } = await supabase.storage.from('order-docs').upload(path, bin, { upsert: false });
    if (upErr) return { error: `上传失败:${upErr.message}` };
    // 合并已有凭证路径
    const svc = createServiceRoleClient();
    const { data: cur } = await (svc.from('purchase_orders') as any).select('order_proof_paths').eq('id', poId).maybeSingle();
    const prev: string[] = Array.isArray((cur as any)?.order_proof_paths) ? (cur as any).order_proof_paths : [];
    const res = await savePurchaseOrderProof(poId, [...prev, path]);
    if (res.error) return { error: res.error };
    revalidatePath(`/orders/${orderId}`);
    return { ok: true };
  } catch (e: any) {
    return { error: e?.message || '上传异常' };
  }
}
