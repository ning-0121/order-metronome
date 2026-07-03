// ============================================================
// 财务系统集成 — 从节拍器推送数据到财务系统
// 安全：HMAC-SHA256 签名 + API Key + 时间戳防重放
// ============================================================

import { createHmac } from 'crypto'

const FINANCE_SYSTEM_URL = process.env.FINANCE_SYSTEM_URL || ''
const INTEGRATION_API_KEY = process.env.INTEGRATION_API_KEY || ''
const INTEGRATION_WEBHOOK_SECRET = process.env.INTEGRATION_WEBHOOK_SECRET || ''

type WebhookEventType =
  | 'order.created'
  | 'order.updated'
  | 'order.activated'
  | 'order.completed'
  | 'order.cancelled'
  | 'order.deleted'
  | 'order.resync'
  | 'milestone.updated'
  | 'price_approval.requested'
  | 'delay.requested'
  | 'supplier.upserted'
  | 'purchase_order.placed'

interface WebhookPayload {
  event: WebhookEventType
  timestamp: string
  source: 'order-metronome'
  request_id: string
  data: Record<string, unknown>
  signature: string
}

function generateSignature(payload: string): string {
  return createHmac('sha256', INTEGRATION_WEBHOOK_SECRET)
    .update(payload)
    .digest('hex')
}

// --- 通用 Webhook 发送 ---
async function sendToFinanceSystem(
  event: WebhookEventType,
  data: Record<string, unknown>
): Promise<{ success: boolean; error?: string }> {
  if (!FINANCE_SYSTEM_URL || !INTEGRATION_API_KEY) {
    console.log(`[FinanceSync] Skipping ${event}: FINANCE_SYSTEM_URL not configured`)
    return { success: true } // 静默跳过，不影响主流程
  }

  const payload: WebhookPayload = {
    event,
    timestamp: new Date().toISOString(),
    source: 'order-metronome',
    request_id: `om-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    data,
    signature: '',
  }

  const body = JSON.stringify(payload)
  payload.signature = generateSignature(body)
  const signedBody = JSON.stringify(payload)

  try {
    const response = await fetch(`${FINANCE_SYSTEM_URL}/api/integration/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': INTEGRATION_API_KEY,
        'x-webhook-signature': generateSignature(signedBody),
        'x-source': 'order-metronome',
      },
      body: signedBody,
      signal: AbortSignal.timeout(10_000), // 10秒超时
    })

    if (!response.ok) {
      const text = await response.text()
      console.error(`[FinanceSync] ${event} failed: HTTP ${response.status} - ${text}`)
      return { success: false, error: `HTTP ${response.status}` }
    }

    const result = await response.json()
    console.log(`[FinanceSync] ${event} sent successfully:`, result.request_id)
    return { success: true }
  } catch (error) {
    // 网络错误不应影响节拍器主流程
    const msg = error instanceof Error ? error.message : 'unknown'
    console.error(`[FinanceSync] ${event} network error: ${msg}`)
    return { success: false, error: msg }
  }
}

// ============================================================
// 公开 API — 在节拍器业务逻辑中调用
// ============================================================

/** 订单创建/更新时同步到财务系统 */
export async function syncOrderToFinance(order: Record<string, unknown>, event: 'order.created' | 'order.updated' | 'order.activated' | 'order.resync' = 'order.updated') {
  return sendToFinanceSystem(event, {
    id: order.id,
    order_no: order.order_no,
    customer_name: order.customer_name,
    incoterm: order.incoterm,
    delivery_type: order.delivery_type,
    order_type: order.order_type,
    lifecycle_status: order.lifecycle_status,
    po_number: order.po_number || null,
    currency: order.currency || null,
    unit_price: order.unit_price || null,
    total_amount: order.total_amount || null,
    quantity: order.quantity || null,
    quantity_unit: order.quantity_unit || null,
    factory_name: order.factory_name || null,
    etd: order.etd || null,
    payment_terms: order.payment_terms || null,
    style_no: order.style_no || null,
    notes: order.notes || null,
    created_by: order.created_by,
    created_at: order.created_at,
    updated_at: order.updated_at,
  })
}

/** 订单完成时通知财务系统 */
export async function notifyOrderCompleted(order: Record<string, unknown>) {
  return sendToFinanceSystem('order.completed', order)
}

/** 订单取消时通知财务系统 */
export async function notifyOrderCancelled(order: Record<string, unknown>) {
  return sendToFinanceSystem('order.cancelled', order)
}

/**
 * 订单删除时通知财务系统作废(应收/应付/预算/已同步PO应付 全部冲销)。
 * 带完整标识(order_no/internal_order_no)+ 关联采购单号,供财务侧精确核销。
 */
export async function notifyOrderDeleted(payload: {
  id: string; order_no?: string | null; internal_order_no?: string | null; customer_name?: string | null; po_nos?: string[];
}) {
  return sendToFinanceSystem('order.deleted', payload as any)
}

/** 推送价格审批请求到财务系统 */
export async function pushPriceApprovalToFinance(approval: {
  id: string
  order_no: string
  customer_name: string
  po_number: string
  requested_by: string
  requester_name: string
  price_diffs: unknown[]
  summary: string
  form_snapshot: Record<string, unknown>
  expires_at: string
  created_at: string
}) {
  return sendToFinanceSystem('price_approval.requested', approval as unknown as Record<string, unknown>)
}

/** 推送延期审批请求到财务系统 */
export async function pushDelayApprovalToFinance(delay: {
  id: string
  order_id: string
  order_no: string
  milestone_name: string
  requested_by: string
  requester_name: string
  reason_type: string
  reason_detail: string
  reason_category: string
  proposed_new_date: string | null
  current_due_date: string | null
  requires_customer_approval: boolean
  created_at: string
}) {
  return sendToFinanceSystem('delay.requested', delay as unknown as Record<string, unknown>)
}

// ============================================================
// 采购 P2b — 供应商 + 采购单 → 财务系统同步
// 财务侧建应付主体 / 应付+付款计划。共享 supplier_id / po_no，幂等 upsert。
// 端到端需财务 repo 实现 accept（见 docs/integration/15）。未配置即静默跳过。
// ============================================================

/** 供应商同步 payload（纯，可测）。含财务字段供财务建应付主体。 */
export function buildSupplierSyncPayload(s: Record<string, unknown>): Record<string, unknown> {
  return {
    supplier_id: s.id,
    supplier_code: s.supplier_code ?? null,
    name: s.name,
    main_category: s.main_category ?? null,
    payment_method: s.payment_method ?? null,
    net_days: s.net_days ?? null,
    bank_info: s.bank_info ?? null,
    tax_id: s.tax_id ?? null,
    status: s.status ?? null,
    updated_at: s.updated_at ?? null,
  }
}

/** 采购单同步 payload（纯，可测）。placed 时推金额/账期供财务建应付+付款计划。 */
export function buildPurchaseOrderSyncPayload(
  po: Record<string, unknown>,
  orderRefs?: unknown[],
  supplements?: Array<{ item_no?: string | null; material_name?: string | null; qty?: number | null; reason?: string | null }>,
): Record<string, unknown> {
  return {
    po_no: po.po_no,
    purchase_order_id: po.id,
    supplier_id: po.supplier_id,
    total_amount: po.total_amount ?? null,
    currency: po.currency ?? null,
    payment_terms: po.payment_terms ?? null,
    delivery_date: po.delivery_date ?? null,
    order_refs: orderRefs ?? (po.order_ids as unknown[]) ?? [],
    status: po.status ?? null,
    placed_at: po.updated_at ?? null,
    // 补采购预警(2026-07-03):此单含补采购项 → 财务侧应作预算外预警/归因
    has_supplement: (supplements?.length || 0) > 0,
    supplements: supplements ?? [],
  }
}

/** 供应商 upsert（财务字段完善时）→ 财务应付主体 */
export async function syncSupplierToFinance(supplier: Record<string, unknown>) {
  return sendToFinanceSystem('supplier.upserted', buildSupplierSyncPayload(supplier))
}

/** 采购单 placed → 财务应付 + 付款计划(含补采购预警 flag) */
export async function syncPurchaseOrderToFinance(
  po: Record<string, unknown>,
  orderRefs?: unknown[],
  supplements?: Array<{ item_no?: string | null; material_name?: string | null; qty?: number | null; reason?: string | null }>,
) {
  return sendToFinanceSystem('purchase_order.placed', buildPurchaseOrderSyncPayload(po, orderRefs, supplements))
}

/** 检查财务系统连通性 */
export async function checkFinanceSystemHealth(): Promise<boolean> {
  if (!FINANCE_SYSTEM_URL) return false
  try {
    const response = await fetch(`${FINANCE_SYSTEM_URL}/api/integration/health`, {
      headers: { 'x-api-key': INTEGRATION_API_KEY },
      signal: AbortSignal.timeout(5_000),
    })
    return response.ok
  } catch {
    return false
  }
}
