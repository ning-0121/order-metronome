/**
 * 事件驱动扣款 —— 节拍器侧发起端(财务契约 v1,2026-08-03)。
 *
 * 【为什么要有这个模块】
 * 2026-08-02 真实事故:要扣加工厂的几笔费用(合计 ¥1500),圆圆忘了登记。
 * 老板的洞察是对的:
 *   「工厂有扣款,一定是之前有验货的问题?订单补原辅料的问题?
 *     这个一定是有事件引发的,所以我们要看看如何通过事件来锁死工厂扣款这个事情。」
 *
 * 让人「记得登记扣款」是防不住的 —— 勾选框只能防**忘了填**,防不住**不知道有**。
 * 正确做法是把因果链锁上:验货不合格 / 补料 / 返工 → 财务自动建「待扣款」→
 * 对账审批时未处理就卡住。系统**先于人**知道该扣钱,「忘记」在结构上不可能。
 *
 * 【治理红线 —— 别越界】
 * 这里发的 amount 是**建议值**。实际扣多少、扣不扣、豁免与否,
 * 必须财务在自己的 UI 里确认并记真实 auth.uid()。
 * 节拍器只负责说「这里发生了一件该扣钱的事」,**不替财务核销**。
 *
 * 【liable_party 是关键开关】
 * 客户改单导致的补料 ≠ 工厂责任。非 supplier/factory 时财务侧不建扣款(返回 ignored)。
 * 传错了就是冤枉供应商,所以调用方必须显式给,不给默认值。
 *
 * 【幂等】
 * request_id 用 sha256(event|payload) 确定性生成(与其它事件同源),重投不重复建。
 * event_ref 是业务侧锚点(验货单号等),撤销时用它定位 —— 必须稳定、可回溯。
 */

import { sendToFinanceSystem } from './finance-sync'

/** 谁担责。只有 supplier/factory 会让财务建扣款,其余一律不建。 */
export type LiableParty = 'supplier' | 'factory' | 'customer' | 'qimo' | 'unknown'

export interface DeductionEventInput {
  /** 节拍器侧业务单号(验货单号/补料单号/返工单号)。撤销时按它定位,必须稳定。 */
  eventRef: string
  occurredAt?: string | Date | null
  supplierName: string | null
  supplierId?: string | null
  orderId?: string | null
  orderNo?: string | null
  internalOrderNo?: string | null
  purchaseOrderNo?: string | null
  liableParty: LiableParty
  /** 建议扣款额(财务可改)。非工厂担责时可为 0/null。 */
  amount?: number | null
  currency?: string
  reason: string
  detail?: Record<string, unknown>
}

const iso = (v: string | Date | null | undefined): string =>
  v instanceof Date ? v.toISOString() : (v ? new Date(v).toISOString() : new Date().toISOString())

function buildPayload(input: DeductionEventInput): Record<string, unknown> {
  const amt = input.amount == null ? null : Number(input.amount)
  return {
    event_ref: input.eventRef,
    occurred_at: iso(input.occurredAt),
    supplier_name: input.supplierName ?? null,
    supplier_id: input.supplierId ?? null,
    qimo_order_id: input.orderId ?? null,
    order_no: input.orderNo ?? null,
    internal_order_no: input.internalOrderNo ?? null,
    purchase_order_no: input.purchaseOrderNo ?? null,
    liable_party: input.liableParty,
    amount: Number.isFinite(amt as number) ? amt : null,
    currency: input.currency ?? 'CNY',
    reason: input.reason,
    detail: input.detail ?? {},
  }
}

/**
 * 三个事件共用一条发送路径。
 * fire-and-forget 由 sendToFinanceSystem 内部保证(失败落 outbox 退避重试),
 * 这里**绝不抛异常**给业务链路 —— 验货/补料/返工本身不能因为财务不通而失败。
 */
async function emit(
  event: 'qc.failed' | 'material.resupplied' | 'rework.recorded',
  input: DeductionEventInput,
): Promise<{ ok: boolean; skipped?: string; error?: string }> {
  if (!input.eventRef) return { ok: false, skipped: 'no_event_ref' }
  if (!input.supplierName && !input.supplierId) {
    // 供应商都不知道是谁,财务无从建扣款 —— 与其发一条建不出来的,不如明确跳过并留日志
    console.warn(`[Deduction] ${event} ${input.eventRef} 无供应商,跳过推送`)
    return { ok: false, skipped: 'no_supplier' }
  }
  try {
    const r = await sendToFinanceSystem(event, buildPayload(input))
    return { ok: !!r?.success, error: (r as any)?.error }
  } catch (e) {
    console.error(`[Deduction] ${event} ${input.eventRef} 推送异常:`, e instanceof Error ? e.message : e)
    return { ok: false, error: 'exception' }
  }
}

/** 验货不合格 → 财务建待扣款(仅当 liableParty 是 supplier/factory) */
export const emitQcFailed = (input: DeductionEventInput) => emit('qc.failed', input)

/** 补原辅料 → 同上。⚠️ 客户改单导致的补料要传 liableParty:'customer',财务不会建扣款。 */
export const emitMaterialResupplied = (input: DeductionEventInput) => emit('material.resupplied', input)

/** 返工 → 同上。amount = 向供应商追偿的返工费用。 */
export const emitReworkRecorded = (input: DeductionEventInput) => emit('rework.recorded', input)

/**
 * 撤销(误报 / 复检合格)。
 * 财务侧只把 **pending** 的待扣款置 cancelled;已处理(applied/waived)的不动 ——
 * 钱已经扣了,那需要人工红冲,不是一个 webhook 能撤的。
 */
export async function emitDeductionCancelled(
  eventRef: string,
  reason: string,
): Promise<{ ok: boolean; skipped?: string; error?: string }> {
  if (!eventRef) return { ok: false, skipped: 'no_event_ref' }
  try {
    const r = await sendToFinanceSystem('deduction.cancelled' as any, { event_ref: eventRef, reason })
    return { ok: !!r?.success, error: (r as any)?.error }
  } catch (e) {
    console.error(`[Deduction] cancel ${eventRef} 推送异常:`, e instanceof Error ? e.message : e)
    return { ok: false, error: 'exception' }
  }
}
