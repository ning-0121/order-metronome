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

// ── 已下单采购单改供应商:走财务审批(2026-08-19 CEO)────────────

/** 读一张 PO 的改供应商相关字段(申请/审批用)。 */
export async function readPoSupplierChange(poId: string): Promise<{
  po: { id: string; poNo: string | null; status: string; supplierId: string | null; orderIds: string[];
        // approvalStatus:财务前置审批状态。申请流要靠它区分「草稿未提交审批」(直改)
        // 与「草稿已提交审批」(必须走申请)——漏选这一列会让判据恒为 undefined 而静默失效。
        approvalStatus: string | null;
        changeStatus: string | null; changeTo: string | null; changeToName: string | null;
        changeReason: string | null; requestedBy: string | null } | null;
  error: string | null;
}> {
  const svc = createServiceRoleClient();
  const { data, error } = await (svc.from('purchase_orders') as any)
    .select('id, po_no, status, supplier_id, order_ids, approval_status, supplier_change_status, supplier_change_to, supplier_change_to_name, supplier_change_reason, supplier_change_requested_by')
    .eq('id', poId).maybeSingle();
  if (error) return { po: null, error: error.message };
  if (!data) return { po: null, error: null };
  const d = data as any;
  return { po: {
    id: d.id, poNo: d.po_no ?? null, status: String(d.status), supplierId: d.supplier_id ?? null,
    orderIds: Array.isArray(d.order_ids) ? d.order_ids : [],
    approvalStatus: d.approval_status ?? null,
    changeStatus: d.supplier_change_status ?? null, changeTo: d.supplier_change_to ?? null,
    changeToName: d.supplier_change_to_name ?? null, changeReason: d.supplier_change_reason ?? null,
    requestedBy: d.supplier_change_requested_by ?? null,
  }, error: null };
}

/** 发起改供应商申请(非草稿单):写 pending + 目标供应商。CAS 防并发重复申请。 */
export async function writePoSupplierChangeRequest(params: {
  poId: string; toSupplierId: string; toSupplierName: string | null;
  fromSupplierId: string | null; reason: string | null; requestedBy: string;
}): Promise<{ ok: boolean; error: string | null }> {
  const svc = createServiceRoleClient();
  const { safeMutation } = await import('@/lib/db/safe-mutation');
  const w = await safeMutation({
    client: svc, table: 'purchase_orders', operation: 'update',
    payload: {
      supplier_change_status: 'pending', supplier_change_to: params.toSupplierId,
      supplier_change_to_name: params.toSupplierName, supplier_change_from: params.fromSupplierId,
      supplier_change_reason: params.reason, supplier_change_requested_by: params.requestedBy,
      supplier_change_requested_at: new Date().toISOString(),
      supplier_change_decided_by: null, supplier_change_decided_at: null, supplier_change_decide_note: null,
      updated_at: new Date().toISOString(),
    },
    predicate: { id: params.poId, supplier_change_status: null },   // CAS:已有 pending(非 null)不重复覆盖
  });
  if (!(w as any).ok) return { ok: false, error: (w as any).status === 'zero_rows' ? '该单已有待审批的改供应商申请(请勿重复提交)' : ((w as any).error || '申请写入失败') };
  return { ok: true, error: null };
}

/**
 * 财务批准改供应商:CAS(status='pending')套用新供应商 + 同步执行行 + 落决定字段。
 * 决定后把 supplier_change_status 归 null(而非 'approved')—— status 列只保留 null/pending 两态,
 * 让同一张 PO 日后能再次发起改供应商申请(writePoSupplierChangeRequest 的 CAS 是 status IS NULL;
 * 若停在 'approved'/'rejected' 就永久锁死、无法二次修正,同 [[data-fix-dryrun-gate]] 邻域的老死局)。
 * 决定的痕迹留在 supplier_change_decided_by/at/note + A2 审计事件里,不丢。
 * 返回 { ok, error, headerChanged }:headerChanged=true 表示单头供应商已改(即便行同步失败,
 * 调用方也必须走审计+通知,不能当成整体失败)。
 */
export async function applyPoSupplierChange(params: {
  poId: string; toSupplierId: string; toSupplierName: string | null; decidedBy: string; note: string | null;
}): Promise<{ ok: boolean; error: string | null; headerChanged: boolean }> {
  const svc = createServiceRoleClient();
  const { safeMutation } = await import('@/lib/db/safe-mutation');
  const w = await safeMutation({
    client: svc, table: 'purchase_orders', operation: 'update',
    payload: {
      supplier_id: params.toSupplierId,
      supplier_change_status: null, supplier_change_decided_by: params.decidedBy,
      supplier_change_decided_at: new Date().toISOString(), supplier_change_decide_note: params.note,
      updated_at: new Date().toISOString(),
    },
    predicate: { id: params.poId, supplier_change_status: 'pending' },   // CAS:只批一次
  });
  if (!(w as any).ok) return { ok: false, headerChanged: false, error: (w as any).status === 'zero_rows' ? '申请状态已变化(可能已被处理),请刷新' : ((w as any).error || '批准写入失败') };
  const sync = await syncPoLinesSupplier(params.poId, params.toSupplierId, params.toSupplierName);
  // 单头已改(headerChanged=true);行同步失败只是需人工核对的告警,不能回滚成"整体失败"
  if (sync.error) return { ok: true, headerChanged: true, error: '执行行供应商同步失败,请让采购核对采购行:' + sync.error };
  return { ok: true, headerChanged: true, error: null };
}

/** 财务驳回 / 申请人撤回改供应商:pending → null(决定痕迹留 decided_* + 审计;允许日后再次申请)。 */
export async function rejectPoSupplierChange(params: {
  poId: string; decidedBy: string; note: string | null;
}): Promise<{ ok: boolean; error: string | null }> {
  const svc = createServiceRoleClient();
  const { safeMutation } = await import('@/lib/db/safe-mutation');
  const w = await safeMutation({
    client: svc, table: 'purchase_orders', operation: 'update',
    payload: {
      supplier_change_status: null,
      supplier_change_decided_by: params.decidedBy, supplier_change_decided_at: new Date().toISOString(),
      supplier_change_decide_note: params.note, updated_at: new Date().toISOString(),
    },
    predicate: { id: params.poId, supplier_change_status: 'pending' },
  });
  if (!(w as any).ok) return { ok: false, error: (w as any).status === 'zero_rows' ? '申请状态已变化,请刷新' : ((w as any).error || '驳回写入失败') };
  return { ok: true, error: null };
}

/** 审批中心:待财务批的改供应商申请。 */
export async function listPendingSupplierChanges(): Promise<{ data: Array<{ id: string; poNo: string | null; orderId: string | null; orderRef: string | null; fromName: string | null; toName: string | null; reason: string | null; status: string; requestedAt: string | null }>; error: string | null }> {
  const svc = createServiceRoleClient();
  const { data, error } = await (svc.from('purchase_orders') as any)
    .select('id, po_no, order_ids, supplier_id, supplier_change_to_name, supplier_change_reason, status, supplier_change_requested_at, suppliers(name)')
    .eq('supplier_change_status', 'pending');
  if (error) return { data: [], error: error.message };
  const rows = (data || []) as any[];
  const oids = [...new Set(rows.map((r) => (Array.isArray(r.order_ids) ? r.order_ids[0] : null)).filter(Boolean))];
  const refs = new Map<string, string>();
  if (oids.length) {
    const { data: os } = await (svc.from('orders') as any).select('id, order_no, internal_order_no').in('id', oids);
    for (const o of (os || []) as any[]) refs.set(o.id, o.internal_order_no || o.order_no || '');
  }
  return { data: rows.map((r) => {
    const orderId = Array.isArray(r.order_ids) ? r.order_ids[0] : null;
    return { id: r.id, poNo: r.po_no ?? null, orderId, orderRef: orderId ? (refs.get(orderId) ?? null) : null,
      fromName: r.suppliers?.name ?? null, toName: r.supplier_change_to_name ?? null,
      reason: r.supplier_change_reason ?? null, status: String(r.status), requestedAt: r.supplier_change_requested_at ?? null };
  }), error: null };
}

// ── P1 §8/§9 审批中心读侧(2026-08-19)──────────────────────────

export async function listPendingPurposeChanges(): Promise<{ data: Array<{ id: string; orderId: string; fromPurpose: string; toPurpose: string; reason: string | null; createdAt: string; orderRef: string | null }>; error: string | null }> {
  const svc = createServiceRoleClient();
  const { data, error } = await (svc.from('order_purpose_change_requests') as any)
    .select('id, order_id, from_purpose, to_purpose, reason, created_at').eq('status', 'pending');
  if (error) return { data: [], error: error.message };
  const rows = (data || []) as any[];
  const ids = [...new Set(rows.map((r) => r.order_id).filter(Boolean))];
  const refs = new Map<string, string>();
  if (ids.length) {
    const { data: os } = await (svc.from('orders') as any).select('id, order_no, internal_order_no').in('id', ids);
    for (const o of (os || []) as any[]) refs.set(o.id, o.internal_order_no || o.order_no || '');
  }
  return { data: rows.map((r) => ({ id: r.id, orderId: r.order_id, fromPurpose: String(r.from_purpose ?? ''), toPurpose: String(r.to_purpose ?? ''), reason: r.reason ?? null, createdAt: r.created_at, orderRef: refs.get(r.order_id) ?? null })), error: null };
}

export async function listPendingDocumentReviews(): Promise<{ data: Array<{ id: string; orderId: string; docType: string; createdAt: string; orderRef: string | null }>; error: string | null }> {
  const svc = createServiceRoleClient();
  const { data, error } = await (svc.from('order_documents') as any)
    .select('*').eq('status', 'pending_review');
  if (error) return { data: [], error: error.message };
  const rows = (data || []) as any[];
  const ids = [...new Set(rows.map((r) => r.order_id).filter(Boolean))];
  const refs = new Map<string, string>();
  if (ids.length) {
    const { data: os } = await (svc.from('orders') as any).select('id, order_no, internal_order_no').in('id', ids);
    for (const o of (os || []) as any[]) refs.set(o.id, o.internal_order_no || o.order_no || '');
  }
  return { data: rows.map((r) => ({ id: r.id, orderId: r.order_id, docType: String(r.doc_type ?? r.document_type ?? r.type ?? '单据'), createdAt: r.updated_at || r.created_at, orderRef: refs.get(r.order_id) ?? null })), error: null };
}

/** 已推财务、尚未回执的付款申请(procurement_payment_requests submitted;回调闭环见 finance-callback)。
 *  supplier_ledger_payables 刻意不进:它只有 submitted/void 两态,永不出队,列了就是只增不减的洪水。 */
export async function listPendingPaymentRequests(): Promise<{ data: Array<{ id: string; poId: string | null; requestNo: string | null; amount: number | null; createdAt: string }>; error: string | null }> {
  const svc = createServiceRoleClient();
  const { data, error } = await (svc.from('procurement_payment_requests') as any)
    .select('id, request_no, purchase_order_id, amount, status, created_at').eq('status', 'submitted');
  if (error) return { data: [], error: error.message };
  return { data: ((data || []) as any[]).map((r) => ({ id: r.id, poId: r.purchase_order_id ?? null, requestNo: r.request_no ?? null, amount: r.amount != null ? Number(r.amount) : null, createdAt: r.created_at })), error: null };
}

/**
 * 读某订单全部执行行的「下单状态」——「采购下单」节点自动完成的判据来源。
 *
 * 经销单(trade)买成品、不建 procurement_items,大货采购直接物化成 procurement_line_items,
 * 所以这个节点对经销单只能靠执行行判定(2026-08-19,见 lib/procurement/placedAutoComplete.ts)。
 * 传入 client:调用方给什么用什么(下单钩子在财务回调 webhook 上下文里无 cookie,须用 service-role)。
 */
export async function readOrderLinePlacementStatus(
  client: any,
  orderId: string,
): Promise<{ lines: Array<{ line_status: string | null; purchase_order_id: string | null }> | null; error: string | null }> {
  const { data, error } = await (client.from('procurement_line_items') as any)
    .select('line_status, purchase_order_id').eq('order_id', orderId);
  if (error) return { lines: null, error: error.message };
  return { lines: (data ?? []) as any[], error: null };
}

/** 采购执行行最小引用(2026-08-20:收货补价回财务用;业务层不裸摸表)。 */
export async function getLineRef(
  client: any,
  lineId: string,
): Promise<{ po_no: string | null; material_name: string | null; ordered_qty: number | null } | null> {
  const { data } = await (client.from('procurement_line_items') as any)
    .select('po_no, material_name, ordered_qty').eq('id', lineId).maybeSingle();
  if (!data) return null;
  return {
    po_no: (data as any).po_no ?? null,
    material_name: (data as any).material_name ?? null,
    ordered_qty: (data as any).ordered_qty ?? null,
  };
}
