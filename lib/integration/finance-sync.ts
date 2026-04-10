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
  | 'milestone.updated'
  | 'price_approval.requested'
  | 'delay.requested'

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
export async function syncOrderToFinance(order: Record<string, unknown>, event: 'order.created' | 'order.updated' | 'order.activated' = 'order.updated') {
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
