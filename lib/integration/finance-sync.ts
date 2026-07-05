// ============================================================
// 财务系统集成 — 从节拍器推送数据到财务系统
// 安全：HMAC-SHA256 签名 + API Key + 时间戳防重放
// ============================================================

import { createHmac, createHash } from 'crypto'

/**
 * 幂等键(审计 P1):原用 `om-${Date.now()}-${random}` → 每次随机,财务侧按 request_id
 * 去重永不命中,resync/重试会重复入账。改为 event + data 内容哈希的确定性键:
 * 相同内容重发(resync 无变化)→ 同键 → 财务去重;订单真改了 → 内容变 → 新键 → 照常处理。
 * timestamp 不参与哈希(在 payload 外层),故纯重试稳定同键。
 */
function deterministicRequestId(event: string, data: Record<string, unknown>): string {
  const h = createHash('sha256').update(`${event}|${JSON.stringify(data)}`).digest('hex').slice(0, 24)
  return `om-${event}-${h}`
}

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
  | 'quotation.frozen'
  | 'supplier.upserted'
  | 'purchase_order.placed'
  | 'purchase_order.approval_requested'
  | 'goods_receipt.recorded'

interface WebhookPayload {
  event: WebhookEventType
  timestamp: string
  source: 'order-metronome'
  request_id: string
  data: Record<string, unknown>
  // 签名只走 header(x-webhook-signature),不再内嵌 payload.signature —— 财务侧从不读它(审计 A1)。
}

function generateSignature(payload: string): string {
  return createHmac('sha256', INTEGRATION_WEBHOOK_SECRET)
    .update(payload)
    .digest('hex')
}

// --- 原始投递(不落 outbox)：首发与重试共用;requestId 外部传入,保证重试同键幂等 ---
async function deliverToFinance(
  event: WebhookEventType,
  data: Record<string, unknown>,
  requestId: string,
): Promise<{ success: boolean; error?: string }> {
  if (!FINANCE_SYSTEM_URL || !INTEGRATION_API_KEY) return { success: true } // 未配置=静默跳过
  const payload: WebhookPayload = {
    event, timestamp: new Date().toISOString(), source: 'order-metronome', request_id: requestId, data,
  }
  // 签名只走 header:对最终 body 做一次 HMAC(审计 A1:删掉内嵌 payload.signature 死字段)
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
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return { success: false, error: `HTTP ${response.status} - ${text.slice(0, 200)}` }
    }
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'unknown' }
  }
}

// --- outbox 退避重试参数(审计 A3)---
const OUTBOX_MAX_ATTEMPTS = 6
const outboxBackoffMs = (attempts: number) => Math.min(2 ** attempts, 60) * 60_000 // 2/4/8/16/32/60 分钟

/** 失败落发件箱(幂等 request_id;已在队列则忽略)——绝不 fire-and-forget 丢单。 */
async function enqueueFinanceOutbox(event: WebhookEventType, data: Record<string, unknown>, requestId: string, error?: string) {
  try {
    const { createServiceRoleClient } = await import('@/lib/supabase/server')
    await (createServiceRoleClient().from('integration_outbox') as any).upsert({
      target: 'finance', event, payload: data, request_id: requestId, status: 'failed', attempts: 1,
      last_error: (error || '').slice(0, 500), next_retry_at: new Date(Date.now() + outboxBackoffMs(1)).toISOString(),
    }, { onConflict: 'request_id', ignoreDuplicates: true })
  } catch (e) {
    console.error('[FinanceSync] outbox 入队失败:', e instanceof Error ? e.message : e)
  }
}

// --- 通用 Webhook 发送:首发失败 → 落 outbox 待重试(不再静默丢单) ---
async function sendToFinanceSystem(
  event: WebhookEventType,
  data: Record<string, unknown>
): Promise<{ success: boolean; error?: string }> {
  if (!FINANCE_SYSTEM_URL || !INTEGRATION_API_KEY) {
    console.log(`[FinanceSync] Skipping ${event}: FINANCE_SYSTEM_URL not configured`)
    return { success: true }
  }
  const requestId = deterministicRequestId(event, data)
  const r = await deliverToFinance(event, data, requestId)
  if (!r.success) {
    console.error(`[FinanceSync] ${event} 首发失败(${r.error}) → 落 outbox 待重试`)
    await enqueueFinanceOutbox(event, data, requestId, r.error)
  }
  return r
}

/** cron 调用:退避重试 outbox 里待重发的失败投递;超上限置 dead(可见,待人工)。 */
export async function processFinanceOutbox(limit = 30): Promise<{ retried: number; sent: number; dead: number }> {
  const { createServiceRoleClient } = await import('@/lib/supabase/server')
  const svc = createServiceRoleClient()
  const nowIso = new Date().toISOString()
  const { data: due } = await (svc.from('integration_outbox') as any)
    .select('id, event, payload, request_id, attempts')
    .eq('status', 'failed').lt('attempts', OUTBOX_MAX_ATTEMPTS)
    .or(`next_retry_at.is.null,next_retry_at.lte.${nowIso}`)
    .order('created_at', { ascending: true }).limit(limit)
  let sent = 0, dead = 0
  for (const row of (due || [])) {
    const rid = row.request_id || deterministicRequestId(row.event, row.payload)
    const r = await deliverToFinance(row.event, row.payload, rid)
    if (r.success) {
      await (svc.from('integration_outbox') as any).update({ status: 'sent', sent_at: new Date().toISOString(), last_error: null }).eq('id', row.id)
      sent++
    } else {
      const attempts = (row.attempts || 1) + 1
      const status = attempts >= OUTBOX_MAX_ATTEMPTS ? 'dead' : 'failed'
      if (status === 'dead') dead++
      await (svc.from('integration_outbox') as any).update({
        attempts, status, last_error: (r.error || '').slice(0, 500),
        next_retry_at: new Date(Date.now() + outboxBackoffMs(attempts)).toISOString(),
      }).eq('id', row.id)
    }
  }
  return { retried: (due || []).length, sent, dead }
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
    factory_date: order.factory_date || null,   // 审计#2:重排改的是工厂日,财务需看到新交期
    etd: order.etd || null,
    warehouse_due_date: order.warehouse_due_date || null,
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
  // 无底价采购单(无价版)total_amount 汇总为 0 → 发 null + amount_pending,
  // 避免财务建一笔 ¥0 应付污染台账(审计 2026-07-04);真实金额待补价后由 resync 补。
  const rawAmount = Number(po.total_amount);
  const amountKnown = Number.isFinite(rawAmount) && rawAmount > 0;
  return {
    po_no: po.po_no,
    purchase_order_id: po.id,
    supplier_id: po.supplier_id,
    total_amount: amountKnown ? rawAmount : null,
    amount_pending: !amountKnown,
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

/**
 * 采购单 ≥ ¥5000 → 请求外部财务系统审批(审计 B)。载荷同 purchase_order.placed(单头+lines+order_refs)。
 * 财务系统审批后回调 finance-callback(approval_type='purchase', approval_id=采购单 id)→ 批准自动下单。
 */
export async function requestPurchaseOrderApproval(
  po: Record<string, unknown>,
  orderRefs?: unknown[],
  supplements?: Array<{ item_no?: string | null; material_name?: string | null; qty?: number | null; reason?: string | null }>,
  internalRiskFlags?: Record<string, unknown>, // 复审:内部风险信号(超预算/付重/偏离基线/新供应商)结构化带给财务审批
) {
  const data = buildPurchaseOrderSyncPayload(po, orderRefs, supplements)
  if (internalRiskFlags) (data as Record<string, unknown>).internal_risk_flags = internalRiskFlags
  return sendToFinanceSystem('purchase_order.approval_requested', data)
}

/**
 * 收货回财务(审计修 2026-07-04):采购原来只在下单(placed)同步一次应付,收齐/短缺/超收/
 * 让步接收全部不回 → 财务按理论量付款。收货写入成功后 fire-and-forget 发本事件,财务按
 * line_id/po_no 冲销核销应付。财务侧需在 webhook 加 'goods_receipt.recorded' 分支。
 */
export async function syncGoodsReceiptToFinance(payload: {
  po_no?: string | null; line_id: string; order_id?: string | null;
  material_name?: string | null; ordered_qty?: number | null;
  received_qty_total?: number | null; inspection_result?: string | null; line_status?: string | null;
}) {
  return sendToFinanceSystem('goods_receipt.recorded', payload as unknown as Record<string, unknown>)
}

/** 内部成本核算单冻结 → 财务预算(单件单价,财务 ×订单数量 换算)。纯函数,可测。 */
export function buildQuotationFrozenPayload(
  order: Record<string, unknown>,
  baseline: Record<string, unknown>,
): Record<string, unknown> {
  const n = (v: unknown) => (v == null ? null : Number(v))
  return {
    qimo_order_id: order.id,
    order_no: order.order_no,
    internal_order_no: order.internal_order_no ?? order.style_no ?? null,
    quote_id: (order.quote_id as string) ?? (baseline.id as string) ?? null,
    quote_version: (order.quote_snapshot_version as number) ?? 1,
    quotation_at: (baseline.parsed_at as string) ?? null,   // 报价核算日期
    currency: 'CNY',
    exchange_rate: 1,
    // 单件单价：财务侧 × synced_orders.quantity 换算订单预算
    unit_costs: {
      fabric_net_price_per_kg: n(baseline.fabric_price_per_kg),
      fabric_consumption_kg: n(baseline.fabric_consumption_kg),
      fabric_supplier: (baseline.fabric_factory as string) ?? null,
      fabric_name: (baseline.fabric_name as string) ?? null,
      processing_per_piece: n(baseline.cmt_internal_estimate) ?? n(baseline.cmt_factory_quote),
      accessory_per_piece: n(baseline.trim_cost_per_piece),
      selling_price_per_piece: n(baseline.selling_price_per_piece),
    },
  }
}

/** 订单确认时 emit：内部成本核算单冻结 → 财务预算自动到位（有 baseline 才发）。 */
export async function syncQuotationToFinance(order: Record<string, unknown>, baseline: Record<string, unknown> | null) {
  if (!baseline) return { success: true }   // 无成本基线(未上传核算单)则跳过
  return sendToFinanceSystem('quotation.frozen', buildQuotationFrozenPayload(order, baseline))
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
