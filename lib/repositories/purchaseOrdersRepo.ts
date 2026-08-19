// ============================================================
// Purchase Orders Repository —— 采购单读侧收口(2026-08-18)
//
// 起因:PO-20260817-001(成品大货 ¥285,882)置了 approval_status='pending' 后,
// 财务和采购经理都"没收到审批"。排查结论:
//   · 外发财务系统的 webhook 首发成功(outbox 为空);
//   · 内部通知也发了(po_finance_approval ×3);
//   · 但**待审批中心 8 个类别里根本没有「采购单」这一类** ——
//     审批人的工作台看不见它,只能靠铃铛通知或自己想起来去采购中心翻草稿列表。
// 这是「审批不达」反复复发的结构性原因:每种审批都要登记进待审批中心,PO 从来没登记过。
//
// 本文件只做 persistence;审批权限判定留在 service 层。
// 内部用 service-role 读:审批人(财务)的 session 未必过得了 purchase_orders 的 RLS,
// 读不到 → 类别静默空 → 又是一次"审批不达"。与 notifyUsersByRole 同一处理方式。
// ============================================================
import { createServiceRoleClient } from '@/lib/supabase/server';

export interface PendingApprovalPo {
  id: string;
  poNo: string | null;
  totalAmount: number | null;
  currency: string | null;
  supplierName: string | null;
  approvalRequiredBy: string[];
  approvalReasons: string[];
  createdAt: string;
  /** 关联订单的内部单号(展示用,可多张) */
  orderRefs: string[];
  /** 第一张关联订单 id(跳转兜底用) */
  firstOrderId: string | null;
}

/** 全部待审批采购单(approval_status='pending')。 */
export async function listPendingApprovalPurchaseOrders(): Promise<{ data: PendingApprovalPo[]; error: string | null }> {
  const svc = createServiceRoleClient();
  const { data, error } = await (svc.from('purchase_orders') as any)
    .select('id, po_no, total_amount, currency, supplier_id, supplier_name, approval_required_by, approval_reasons, order_ids, created_at, suppliers(name)')
    .eq('approval_status', 'pending');
  if (error) {
    // suppliers 关系/列缺失 → 降级重读(不 brick 待审批中心)
    if (/suppliers|supplier_name|relationship|schema cache|column/i.test(error.message || '')) {
      const retry = await (svc.from('purchase_orders') as any)
        .select('id, po_no, total_amount, currency, approval_required_by, approval_reasons, order_ids, created_at')
        .eq('approval_status', 'pending');
      if (retry.error) return { data: [], error: retry.error.message };
      return { data: await enrich(svc, retry.data || []), error: null };
    }
    return { data: [], error: error.message };
  }
  return { data: await enrich(svc, data || []), error: null };
}

async function enrich(svc: any, rows: any[]): Promise<PendingApprovalPo[]> {
  const allOrderIds = [...new Set(rows.flatMap((r) => (r.order_ids || []) as string[]))].filter(Boolean);
  const refById = new Map<string, string>();
  if (allOrderIds.length > 0) {
    const { data: ords } = await (svc.from('orders') as any)
      .select('id, order_no, internal_order_no').in('id', allOrderIds);
    for (const o of (ords || []) as any[]) refById.set(o.id, o.internal_order_no || o.order_no || o.id.slice(0, 8));
  }
  return rows.map((r) => ({
    id: r.id,
    poNo: r.po_no ?? null,
    totalAmount: r.total_amount != null ? Number(r.total_amount) : null,
    currency: r.currency ?? null,
    supplierName: r.suppliers?.name ?? r.supplier_name ?? null,
    approvalRequiredBy: Array.isArray(r.approval_required_by) ? r.approval_required_by : [],
    approvalReasons: Array.isArray(r.approval_reasons) ? r.approval_reasons : [],
    createdAt: r.created_at,
    orderRefs: ((r.order_ids || []) as string[]).map((id) => refById.get(id)).filter(Boolean) as string[],
    firstOrderId: ((r.order_ids || []) as string[])[0] ?? null,
  }));
}

// ── 补采购审批读侧(2026-08-18,与 PO 审批同一个结构洞的第二个实例)──
// 1022962 实锤:8 条补采购全部 finance_approval_status='pending',采购点「确认采购」
// 被闸拦(正确),但财务的批准入口只藏在核料页 —— 待审批中心看不见,财务不知道要批。

export interface PendingSupplementItem {
  id: string;
  orderId: string;
  itemNo: string | null;
  materialName: string | null;
  color: string | null;
  qty: number | null;
  unit: string | null;
  reason: string | null;
  createdAt: string;
  orderRef: string | null;
}

/** 全部待财务审批的补采购项。 */
export async function listPendingSupplementItems(): Promise<{ data: PendingSupplementItem[]; error: string | null }> {
  const svc = createServiceRoleClient();
  const { data, error } = await (svc.from('procurement_items') as any)
    .select('id, order_id, item_no, material_name, color, total_required_qty, unit, supplement_reason, supplement_requested_at, created_at')
    .eq('is_supplement', true).eq('finance_approval_status', 'pending');
  if (error) return { data: [], error: error.message };
  const rows = (data || []) as any[];
  const orderIds = [...new Set(rows.map((r) => r.order_id).filter(Boolean))];
  const refById = new Map<string, string>();
  if (orderIds.length > 0) {
    const { data: ords } = await (svc.from('orders') as any)
      .select('id, order_no, internal_order_no').in('id', orderIds);
    for (const o of (ords || []) as any[]) refById.set(o.id, o.internal_order_no || o.order_no || '');
  }
  return {
    data: rows.map((r) => ({
      id: r.id,
      orderId: r.order_id,
      itemNo: r.item_no ?? null,
      materialName: r.material_name ?? null,
      color: r.color ?? null,
      qty: r.total_required_qty != null ? Number(r.total_required_qty) : null,
      unit: r.unit ?? null,
      reason: r.supplement_reason ?? null,
      createdAt: r.supplement_requested_at || r.created_at,
      orderRef: refById.get(r.order_id) ?? null,
    })),
    error: null,
  };
}

/** 待财务批的出货放行(sales_signed)。2026-08-19:1022919 死胡同事故——业务被告知等财务,财务却无处可见。 */
export async function listPendingShipmentReleases(): Promise<{ data: Array<{ id: string; orderId: string; qty: number | null; requestedAt: string; orderRef: string | null; customerName: string | null }>; error: string | null }> {
  const svc = createServiceRoleClient();
  const { data, error } = await (svc.from('shipment_confirmations') as any)
    .select('id, order_id, shipment_qty, sales_signed_at, created_at')
    .eq('status', 'sales_signed');
  if (error) return { data: [], error: error.message };
  const rows = (data || []) as any[];
  const ids = [...new Set(rows.map((r) => r.order_id).filter(Boolean))];
  const refs = new Map<string, { ref: string; customer: string | null }>();
  if (ids.length) {
    const { data: os } = await (svc.from('orders') as any).select('id, order_no, internal_order_no, customer_name').in('id', ids);
    for (const o of (os || []) as any[]) refs.set(o.id, { ref: o.internal_order_no || o.order_no || '', customer: o.customer_name ?? null });
  }
  return {
    data: rows.map((r) => ({
      id: r.id, orderId: r.order_id,
      qty: r.shipment_qty != null ? Number(r.shipment_qty) : null,
      requestedAt: r.sales_signed_at || r.created_at,
      orderRef: refs.get(r.order_id)?.ref ?? null,
      customerName: refs.get(r.order_id)?.customer ?? null,
    })),
    error: null,
  };
}

/** 待财务批的超预算采购项(baseline_over_status=pending)。与补采共用审批人,此前只藏在核料页。 */
export async function listPendingBaselineOverItems(): Promise<{ data: Array<{ id: string; orderId: string; itemNo: string | null; materialName: string | null; note: string | null; requestedAt: string; orderRef: string | null }>; error: string | null }> {
  const svc = createServiceRoleClient();
  const { data, error } = await (svc.from('procurement_items') as any)
    .select('id, order_id, item_no, material_name, baseline_over_note, baseline_over_requested_at, created_at')
    .eq('baseline_over_status', 'pending');
  if (error) return { data: [], error: error.message };
  const rows = (data || []) as any[];
  const ids = [...new Set(rows.map((r) => r.order_id).filter(Boolean))];
  const refs = new Map<string, string>();
  if (ids.length) {
    const { data: os } = await (svc.from('orders') as any).select('id, order_no, internal_order_no').in('id', ids);
    for (const o of (os || []) as any[]) refs.set(o.id, o.internal_order_no || o.order_no || '');
  }
  return {
    data: rows.map((r) => ({
      id: r.id, orderId: r.order_id, itemNo: r.item_no ?? null, materialName: r.material_name ?? null,
      note: r.baseline_over_note ?? null, requestedAt: r.baseline_over_requested_at || r.created_at,
      orderRef: refs.get(r.order_id) ?? null,
    })),
    error: null,
  };
}

/** 改草稿大货采购单供应商的数据访问(单头 CAS + 行同步)。判定(能不能改/审批作废语义)留在 action。 */
export async function readTradePoForSupplierChange(poId: string): Promise<{ po: { id: string; status: string; approvalStatus: string | null; supplierId: string | null } | null; error: string | null }> {
  const svc = createServiceRoleClient();
  const { data, error } = await (svc.from('purchase_orders') as any)
    .select('id, po_no, status, approval_status, supplier_id').eq('id', poId).maybeSingle();
  if (error) return { po: null, error: error.message };
  if (!data) return { po: null, error: null };
  return { po: { id: (data as any).id, status: String((data as any).status), approvalStatus: (data as any).approval_status ?? null, supplierId: (data as any).supplier_id ?? null }, error: null };
}

export async function readSupplierName(supplierId: string): Promise<{ name: string | null; exists: boolean; error: string | null }> {
  const svc = createServiceRoleClient();
  const { data, error } = await (svc.from('suppliers') as any).select('id, name').eq('id', supplierId).maybeSingle();
  if (error) return { name: null, exists: false, error: error.message };
  return { name: (data as any)?.name ?? null, exists: !!data, error: null };
}

/** 本单执行行的供应商同步(外键指错表时降级只写名字,与建单路径同款兜底)。 */
export async function syncPoLinesSupplier(poId: string, supplierId: string, supplierName: string | null): Promise<{ error: string | null }> {
  const svc = createServiceRoleClient();
  let { error } = await (svc.from('procurement_line_items') as any)
    .update({ supplier_id: supplierId, supplier_name: supplierName, updated_at: new Date().toISOString() })
    .eq('purchase_order_id', poId);
  if (error && /supplier_id_fkey|foreign key/i.test(error.message || '')) {
    ({ error } = await (svc.from('procurement_line_items') as any)
      .update({ supplier_name: supplierName, updated_at: new Date().toISOString() })
      .eq('purchase_order_id', poId));
  }
  return { error: error ? error.message : null };
}
