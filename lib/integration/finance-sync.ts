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
  | 'quotation.frozen'
  | 'order.budget_updated'
  | 'supplier.upserted'
  | 'purchase_order.placed'
  | 'purchase_order.approval_requested'
  | 'purchase_order.approval_cancelled'
  | 'cancel.requested'
  | 'milestone.requested'
  | 'shipment_approval.requested'
  | 'goods_receipt.recorded'
  | 'file.uploaded'
  | 'shipping_invoice.issued'
  | 'payable.created'

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
  // 死信告警(修 P3 2026-07-09):outbox 重试耗尽转 dead 后此前只计数、无人告警 → 审批/应付同步永久失败成无人知晓死行。
  // 给 admin 发站内告警,引导人工处理。fire-and-forget,不阻断 cron。
  if (dead > 0) {
    try {
      const { notifyUsersByRole } = await import('@/lib/utils/notifications')
      await notifyUsersByRole(svc, ['admin'], {
        type: 'integration_dead',
        title: `⛔ ${dead} 条财务同步彻底失败(转 dead)`,
        message: `财务集成 outbox 有 ${dead} 条重试耗尽转为 dead、不再自动重投,可能影响应付/审批/预算同步。请到 integration_outbox 查 status='dead' 的行并人工处理。`,
      })
    } catch (e) { console.error('[processFinanceOutbox] dead 告警发送失败:', e instanceof Error ? e.message : e) }
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

/**
 * 采购执行行 → 财务行(纯映射)。此明细是财务【预算原辅料成本】与【收货核销】的共同源头。
 * ⚠ line_id 严格 = procurement_line_items.id —— 必与收货 goods_receipt.recorded 的 line_id 同源,否则核销匹配不上。
 * category: fabric/trim/packing/other —— 财务据此分预算桶(非 fabric 归辅料)。amount 优先取生成列 ordered_amount。
 */
export function mapPoLineForFinance(l: Record<string, any>): Record<string, unknown> {
  const orders = l.orders as { order_no?: string; internal_order_no?: string } | undefined
  const num = (v: unknown) => (v == null ? null : Number(v))
  return {
    line_id: l.id ?? null,
    order_id: l.order_id ?? null,                             // 关联本系统订单 uuid(财务侧可选锚点;2026-07-08 财务对接补)
    order_no: l.order_no ?? orders?.order_no ?? null,
    internal_order_no: l.internal_order_no ?? orders?.internal_order_no ?? null,
    material_name: l.material_name ?? null,
    material_code: l.material_code ?? null,
    specification: l.specification ?? null,                   // 规格(财务对账/预算按料+规格用;2026-07-08 财务对接补)
    category: l.category ?? null,
    size: l.size ?? null,                                     // 尺码(N1;按码拆的行带上,整行为 null)
    // 预算桶(2026-07-07 用户拍板:辅料不分细类,面料/辅料两桶即可)。财务按 budget_bucket 汇总预算。
    budget_bucket: l.category === 'fabric' ? 'fabric' : 'accessory',
    supplier_id: l.supplier_id ?? null,
    supplier_name: l.supplier_name ?? null,
    ordered_qty: num(l.ordered_qty),
    ordered_unit: l.ordered_unit ?? null,
    unit_price: num(l.unit_price),
    amount: l.ordered_amount != null ? Number(l.ordered_amount)
      : (l.amount != null ? Number(l.amount)
        : (l.unit_price != null && l.ordered_qty != null ? Number(l.unit_price) * Number(l.ordered_qty) : null)),
  }
}

/**
 * 查一张采购单的执行行 + 附订单号,供 buildPurchaseOrderSyncPayload 映射。db=任意 supabase/service-role 客户端。
 * ⚠ 不用 PostgREST 嵌套 join(orders(...)) —— 那依赖 FK schema 缓存,一旦缺失整查静默 fail(CLAUDE.md 血泪教训)。
 * 改为两段查:行 + 按 order_id 批量取 order_no,手动附上,稳。
 */
export async function fetchPurchaseOrderLinesRaw(db: any, poId: string): Promise<any[]> {
  let { data: lines, error: le } = await db.from('procurement_line_items')
    .select('id, order_id, material_name, material_code, specification, category, size, supplier_id, supplier_name, ordered_qty, ordered_unit, unit_price, ordered_amount')
    .eq('purchase_order_id', poId)
  // size 列 schema 缓存未刷新 → 降级去 size(财务对接不因新列拿不到明细)
  if (le && /\bsize\b|schema cache|column .* does not exist|permission denied/i.test(le.message || '')) {
    ({ data: lines } = await db.from('procurement_line_items')
      .select('id, order_id, material_name, material_code, specification, category, supplier_id, supplier_name, ordered_qty, ordered_unit, unit_price, ordered_amount')
      .eq('purchase_order_id', poId))
  }
  const rows: any[] = lines || []
  const orderIds = [...new Set(rows.map((l) => l.order_id).filter(Boolean))]
  if (orderIds.length) {
    const { data: ords } = await db.from('orders').select('id, order_no, internal_order_no').in('id', orderIds)
    const m = new Map((ords || []).map((o: any) => [o.id, o]))
    for (const l of rows) { const o: any = m.get(l.order_id); if (o) { l.order_no = o.order_no; l.internal_order_no = o.internal_order_no } }
  }
  return rows
}

/**
 * 取采购单供应商名(suppliers.name),供 caller 在推财务前附到 po.supplier_name。
 * 单头必带 supplier_name —— 整单一口价(无逐行)时财务全靠它显示供应商。查不到返回 null(不阻断)。
 */
export async function fetchSupplierName(db: any, supplierId: string | null | undefined): Promise<string | null> {
  if (!supplierId) return null
  try {
    const { data } = await db.from('suppliers').select('name').eq('id', supplierId).maybeSingle()
    return (data as { name?: string } | null)?.name ?? null
  } catch { return null }
}

/**
 * 取订单富标识作 order_refs —— 让财务能按【内部订单号】把一张单下面的多张采购单聚合展示。
 * 此前 order_refs 退回用裸 order_ids(UUID),财务只看到 UUID、无法按内部单号归集。db=service-role/任意 client。
 * 查不到返回空(不阻断)。
 */
export async function fetchOrderRefs(
  db: any,
  orderIds: string[] | null | undefined,
): Promise<Array<{ id: string; order_no: string | null; internal_order_no: string | null; customer_name: string | null }>> {
  const ids = [...new Set((orderIds || []).filter(Boolean))]
  if (!ids.length) return []
  try {
    const { data } = await db.from('orders').select('id, order_no, internal_order_no, customer_name').in('id', ids)
    return ((data || []) as any[]).map((o) => ({
      id: o.id, order_no: o.order_no ?? null, internal_order_no: o.internal_order_no ?? null, customer_name: o.customer_name ?? null,
    }))
  } catch { return [] }
}

/**
 * 撤销一张采购单的财务审批(订单被删除/取消时)。财务据此撤掉挂在"采购审批"队列里的待审条目,
 * 否则订单没了、审批还在(payload 幂等,按 po_no/purchase_order_id 定位)。
 */
export async function cancelPurchaseOrderApproval(payload: {
  purchase_order_id: string; po_no?: string | null; order_id?: string | null; reason?: string
}) {
  return sendToFinanceSystem('purchase_order.approval_cancelled', payload as any)
}

/** 采购单同步 payload（纯，可测）。placed 时推金额/账期供财务建应付+付款计划;lines=原辅料明细(财务预算+核销源)。 */
export function buildPurchaseOrderSyncPayload(
  po: Record<string, unknown>,
  orderRefs?: unknown[],
  supplements?: Array<{ item_no?: string | null; material_name?: string | null; qty?: number | null; reason?: string | null }>,
  lines?: unknown[],
): Record<string, unknown> {
  // 无底价采购单(无价版)total_amount 汇总为 0 → 发 null + amount_pending,
  // 避免财务建一笔 ¥0 应付污染台账(审计 2026-07-04);真实金额待补价后由 resync 补。
  const rawAmount = Number(po.total_amount);
  const amountKnown = Number.isFinite(rawAmount) && rawAmount > 0;
  // 单头供应商名(2026-07-08 修):此前只在 lines[].supplier_name 带,整单一口价(lines 为空)时
  // 财务只拿到 supplier_id、库里无 id→名映射 → 显示"未带供应商"。此处必带:优先 po.supplier_name
  // (由 caller 从 suppliers.name 附上),缺失则从明细行取第一个非空兜底。
  const headerSupplierName = (po.supplier_name as string | null | undefined)
    ?? ((lines ?? []).map((l) => (l as Record<string, any>)?.supplier_name).find(Boolean) as string | undefined)
    ?? null;
  return {
    po_no: po.po_no,
    purchase_order_id: po.id,
    supplier_id: po.supplier_id,
    supplier_name: headerSupplierName,
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
    // 原辅料明细(P1-2 修 2026-07-06):此前从不发 lines → 财务 fin_po_lines 恒空、收货按 line_id 100% 匹配不上、
    // 预算原辅料成本建不出。lines[].line_id 严格 = procurement_line_items.id(与收货同源)。
    lines: (lines ?? []).map((l) => mapPoLineForFinance(l as Record<string, any>)),
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
  lines?: unknown[],
) {
  return sendToFinanceSystem('purchase_order.placed', buildPurchaseOrderSyncPayload(po, orderRefs, supplements, lines))
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
  lines?: unknown[],
) {
  const data = buildPurchaseOrderSyncPayload(po, orderRefs, supplements, lines)
  if (internalRiskFlags) (data as Record<string, unknown>).internal_risk_flags = internalRiskFlags
  return sendToFinanceSystem('purchase_order.approval_requested', data)
}

/** H3:取消/里程碑审批发起端 —— 推给财务系统审批队列。字段对齐财务 handleGenericApprovalRequest。 */
export interface ApprovalRequestPayload {
  id: string                    // 必:审批实体 id(cancel_request.id / milestone.id),财务批准回传 approval_id 用它
  order_no?: string | null
  customer_name?: string | null
  requester_name?: string | null
  summary?: string | null
  // detail:结构化对象最佳(财务 toPairs 按 KEY_LABEL 中文铺开:step_key/amount/currency/reason/
  // old_price/new_price/processing_amount/… 见财务 IntegrationApprovals.tsx)。字符串亦兼容(显示为「说明」)。
  detail?: string | Record<string, unknown> | null
  created_at?: string | null
}
export async function syncCancelRequestToFinance(p: ApprovalRequestPayload) {
  return sendToFinanceSystem('cancel.requested', p as unknown as Record<string, unknown>)
}
export async function syncMilestoneRequestToFinance(p: ApprovalRequestPayload) {
  return sendToFinanceSystem('milestone.requested', p as unknown as Record<string, unknown>)
}
/**
 * 出货财务审批请求 → 财务系统「集成审批」队列。
 * p.id = shipment_confirmations.id(财务批准/驳回后回传 approval_id=它,approval_type='shipment')。
 * 财务侧渲染在审批队列,通过→回传 approved(节拍器转 warehouse_signed,放行物流);驳回→pending。
 */
export async function syncShipmentApprovalToFinance(p: ApprovalRequestPayload) {
  return sendToFinanceSystem('shipment_approval.requested', p as unknown as Record<string, unknown>)
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

/**
 * 采购付款申请 → 财务应付(P2,2026-07-11)。采购对账确认后分批(自定义金额)提交,财务按
 * payable.created 建 payable_records(=付款申请)。source_ref=节拍器付款申请 id(入站幂等 +
 * 付款完成回带);bill_no=PR 单号((supplier_name,bill_no) 防重付)。财务侧需在 webhook 加分支。
 */
export async function emitProcurementPayableToFinance(payload: {
  source_ref: string; bill_no: string; supplier_name?: string | null; supplier_id?: string | null;
  amount: number; currency?: string | null; description?: string | null;
  reconciliation_id?: string | null; purchase_order_id?: string | null; po_no?: string | null;
  order_refs?: unknown[]; due_date?: string | null;
}) {
  return sendToFinanceSystem('payable.created', payload as unknown as Record<string, unknown>)
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

/**
 * 采购核料预算 payload(纯,可测)。2026-07-08 弃用报价单识别后,预算由业务在采购核料按真实物料填,
 * 送【绝对总额】(面料/加工/辅料),财务按 qimo_order_id 幂等 upsert 订单预算(不再靠 单件价×数量,
 * 因为逐款件数不一,per-piece×总数会漂;总额是唯一权威口径)。unit_costs 仅供参考展示。
 */
export function buildOrderBudgetPayload(input: {
  qimo_order_id: string; order_no?: string | null; internal_order_no?: string | null; quantity?: number | null;
  fabric_amount?: number | null; cmt_amount?: number | null; accessory_amount?: number | null;
  fabric_per_piece?: number | null; cmt_per_piece?: number | null; accessory_per_piece?: number | null;
  actual_accessory_amount?: number | null;   // 实际辅料总价(采购填的单价×数量)
  actual_fabric_amount?: number | null;      // 实际面料总价(采购填的单价×数量)
  actual_cmt_amount?: number | null;         // 实际加工费(采购核料填的加工费;采购不另议→= 预算加工费)
}): Record<string, unknown> {
  const pos = (v: unknown) => { const x = Number(v); return isFinite(x) && x > 0 ? Math.round(x * 100) / 100 : null }
  const fabric = pos(input.fabric_amount); const cmt = pos(input.cmt_amount); const acc = pos(input.accessory_amount)
  const total = Math.round(((fabric || 0) + (cmt || 0) + (acc || 0)) * 100) / 100
  return {
    qimo_order_id: input.qimo_order_id,
    order_no: input.order_no ?? null,
    internal_order_no: input.internal_order_no ?? null,
    currency: 'CNY',
    exchange_rate: 1,
    quantity: input.quantity ?? null,
    budget_totals: {
      fabric_amount: fabric,
      cmt_amount: cmt,
      accessory_amount: acc,
      total: total > 0 ? total : null,
    },
    // 实际(采购填价):辅料 + 面料 + 加工,与 budget_totals 一一对照(财务看 预算 vs 采购价 差额)
    actual_totals: {
      fabric_amount: pos(input.actual_fabric_amount),
      cmt_amount: pos(input.actual_cmt_amount),
      accessory_amount: pos(input.actual_accessory_amount),
    },
    unit_costs: {   // 参考口径(元/件);权威以 budget_totals 为准
      fabric_per_piece: pos(input.fabric_per_piece),
      processing_per_piece: pos(input.cmt_per_piece),
      accessory_per_piece: pos(input.accessory_per_piece),
    },
    source: 'procurement_verify',
  }
}

/**
 * 采购核料预算即时同步 → 财务(2026-07-08:业务在采购核料填/改预算,立即推财务更新订单预算)。
 * 全 0 = 还没填 → 跳过,不推空预算污染台账(与 PO 下单不建 ¥0 应付同理)。
 * 内容哈希幂等:同预算重发去重,真改了就是新键 → 财务照常更新。首发失败落 outbox 自动重试。
 */
export async function syncOrderBudgetToFinance(input: Parameters<typeof buildOrderBudgetPayload>[0]) {
  const payload = buildOrderBudgetPayload(input)
  const total = Number((payload.budget_totals as Record<string, unknown>)?.total) || 0
  const at = (payload.actual_totals as Record<string, unknown>) || {}
  const actualSum = (Number(at.accessory_amount) || 0) + (Number(at.fabric_amount) || 0) + (Number(at.cmt_amount) || 0)
  if (total <= 0 && actualSum <= 0) return { success: true }   // 预算和实际都空 → 不推(不污染台账)
  return sendToFinanceSystem('order.budget_updated', payload)
}

/**
 * 出货单据文件送达财务(阶段一,2026-07-10):出运完成时把 装箱单/CI/PI/报关 的 Excel
 * 落存储、取 URL,逐张发本事件 → 财务 uploaded_documents 出现这几张单(财务侧已有 file.uploaded
 * 处理器,零改动)。id 由内容确定性生成(见 caller),重发按 id upsert 幂等。
 * extracted_fields 带业务锚点(order_no/internal_order_no/doc_kind/batch_id)供财务归集。
 */
export async function syncFileToFinance(payload: {
  id: string; file_name: string; file_type?: string; file_size?: number | null;
  file_url: string; matched_customer?: string | null;
  extracted_fields?: Record<string, unknown>;
}) {
  return sendToFinanceSystem('file.uploaded', payload as unknown as Record<string, unknown>)
}

/**
 * 出货发票金额 → 财务应收(阶段二,2026-07-10)。纯映射,可测。
 * invoice_amount = 该订单【累计已出运各批 CI 金额之和】(整单口径,幂等:再算得同值)。
 * 财务侧语义(用户拍板):budget_order 为 draft 未确认 → 以本金额更新 total_revenue(应收);
 * 已确认(approved/closed 等)→ 只告警不改账。deposit_raw 是 PI 定金原文(可能是 "30%"/金额),财务存快照参考。
 */
export function buildShippingInvoicePayload(input: {
  qimo_order_id: string; order_no?: string | null; internal_order_no?: string | null;
  currency: string; invoice_amount: number | null; invoice_qty?: number | null;
  deposit_raw?: string | null;
  scopes?: Array<{ scope: string; amount: number | null; qty: number | null }>;
}): Record<string, unknown> {
  const r2 = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? Math.round(x * 100) / 100 : null }
  return {
    qimo_order_id: input.qimo_order_id,
    order_no: input.order_no ?? null,
    internal_order_no: input.internal_order_no ?? null,
    currency: input.currency || 'USD',
    invoice_amount: r2(input.invoice_amount),
    invoice_qty: input.invoice_qty != null ? Number(input.invoice_qty) : null,
    deposit_raw: input.deposit_raw ?? null,
    scopes: (input.scopes ?? []).map((s) => ({ scope: s.scope, amount: r2(s.amount), qty: s.qty != null ? Number(s.qty) : null })),
    source: 'qimo_shipping_ci',
  }
}

/**
 * 出货发票金额同步 → 财务(阶段二)。金额 ≤0(无价版/未出运)不发,避免把 ¥0 应收写进台账。
 * 内容哈希幂等:同金额重发去重,再出一批(金额变)→ 新键 → 财务照常更新。首发失败落 outbox 自动重试。
 */
export async function syncShippingInvoiceToFinance(input: Parameters<typeof buildShippingInvoicePayload>[0]) {
  const payload = buildShippingInvoicePayload(input)
  if ((Number(payload.invoice_amount) || 0) <= 0) return { success: true }   // 无金额不入账
  return sendToFinanceSystem('shipping_invoice.issued', payload)
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
