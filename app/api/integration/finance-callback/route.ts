// ============================================================
// POST /api/integration/finance-callback
// 接收财务系统审批结果的回调
// 安全：API Key + HMAC签名验证
// ============================================================

import { NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'crypto'
import { createClient } from '@/lib/supabase/server'

const INTEGRATION_API_KEY = process.env.INTEGRATION_API_KEY || ''
const INTEGRATION_WEBHOOK_SECRET = process.env.INTEGRATION_WEBHOOK_SECRET || ''

interface ApprovalCallback {
  event: string
  timestamp: string
  source: string
  request_id: string
  data: {
    approval_id: string
    // P0-4 修复：补 'milestone'。L106 实际处理这种类型（财务确认加工费/核准出运/收款等里程碑）
    // 但 union 之前漏写，导致 TS 判类型不重叠、IDE 提示死代码
    approval_type: 'price' | 'delay' | 'cancel' | 'milestone'
    decision: 'approved' | 'rejected'
    decided_by: string
    decider_name: string
    decision_note: string | null
    decided_at: string
  }
  signature: string
}

export async function POST(request: Request) {
  // 1. API Key 验证
  const apiKey = request.headers.get('x-api-key')
  if (!apiKey || !verifyKey(apiKey)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // 2. 读取并验证签名
  const body = await request.text()
  const signature = request.headers.get('x-webhook-signature')
  if (!signature || !verifySignature(body, signature)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  // 3. 解析
  let payload: ApprovalCallback
  try {
    payload = JSON.parse(body)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (payload.source !== 'finance-system') {
    return NextResponse.json({ error: 'Invalid source' }, { status: 403 })
  }

  // 3.5 时间戳窗口(审计修 2026-07-05):原来只验 key+签名、无时间戳 → 抓到一次合法回调即可
  // 无限重放(尤其 finance-events 是 append-only,重放会插重复资金事件)。加 5 分钟窗口兜住。
  const tsMs = Date.parse(payload.timestamp || '')
  if (!payload.timestamp || Number.isNaN(tsMs) || Math.abs(Date.now() - tsMs) > 5 * 60 * 1000) {
    return NextResponse.json({ error: 'Request expired (replay prevention)' }, { status: 401 })
  }

  // 财务进度事件（结算/收款/付款完成）——append-only 记进 order_finance_events，
  // 让节拍器看到资金进度(此前财务进度对节拍器全黑盒)。按 qimo_order_id=orders.id 精确关联。
  const FINANCE_PROGRESS = new Set(['settlement.closed', 'collection.received', 'payment.completed'])
  if (FINANCE_PROGRESS.has((payload as unknown as { event?: string }).event || '')) {
    const d = payload.data as unknown as { qimo_order_id?: string; order_no?: string; amount?: number; currency?: string; note?: string; at?: string }
    try {
      // 审计 A4:改用 service-role 写(绕过 RLS,配合去掉 anon INSERT 策略);
      // 幂等键 request_id + onConflict DO NOTHING → 5 分钟窗口内重放同一回调不重复记账。
      const { createServiceRoleClient } = await import('@/lib/supabase/server')
      const svc = createServiceRoleClient()
      const { error } = await (svc.from('order_finance_events') as unknown as { upsert: (v: unknown, o: unknown) => Promise<{ error: { message: string } | null }> }).upsert({
        request_id: payload.request_id || null,
        order_id: d.qimo_order_id || null,
        order_no: d.order_no || null,
        event_type: (payload as unknown as { event: string }).event,
        amount: d.amount ?? null,
        currency: d.currency || null,
        note: d.note || null,
        occurred_at: d.at || new Date().toISOString(),
      }, { onConflict: 'request_id', ignoreDuplicates: true })
      if (error) throw new Error(error.message)
      return NextResponse.json({ status: 'ok', recorded: (payload as unknown as { event: string }).event })
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'record failed' }, { status: 500 })
    }
  }

  const { approval_id, approval_type, decision, decider_name, decision_note } = payload.data

  try {
    const supabase = await createClient()

    // 4. 根据审批类型更新对应表
    if (approval_type === 'price') {
      const { error } = await supabase
        .from('pre_order_price_approvals')
        .update({
          status: decision,
          review_note: decision_note
            ? `[财务系统-${decider_name}] ${decision_note}`
            : `[财务系统-${decider_name}] ${decision === 'approved' ? '审批通过' : '审批驳回'}`,
          reviewed_at: new Date().toISOString(),
        })
        .eq('id', approval_id)

      if (error) throw new Error(`Price approval update failed: ${error.message}`)
    }

    if (approval_type === 'delay') {
      const { error } = await supabase
        .from('delay_requests')
        .update({
          status: decision,
          decision_note: decision_note
            ? `[财务系统-${decider_name}] ${decision_note}`
            : `[财务系统-${decider_name}] ${decision === 'approved' ? '审批通过' : '审批驳回'}`,
          approved_at: new Date().toISOString(),
        })
        .eq('id', approval_id)

      if (error) throw new Error(`Delay approval update failed: ${error.message}`)
    }

    if (approval_type === 'cancel') {
      const { error } = await supabase
        .from('cancel_requests')
        .update({
          status: decision,
          decided_at: new Date().toISOString(),
        })
        .eq('id', approval_id)

      if (error) throw new Error(`Cancel approval update failed: ${error.message}`)
    }

    // 里程碑审批（财务确认加工费/核准出运/收款等）
    if (approval_type === 'milestone') {
      const newStatus = decision === 'approved' ? '已完成' : '阻塞'
      const { error } = await supabase
        .from('milestones')
        .update({
          status: newStatus,
          actual_at: decision === 'approved' ? new Date().toISOString() : null,
          notes: decision_note
            ? `[财务系统-${decider_name}] ${decision_note}`
            : `[财务系统-${decider_name}] ${decision === 'approved' ? '财务已确认' : '财务驳回'}`,
        })
        .eq('id', approval_id)

      if (error) throw new Error(`Milestone update failed: ${error.message}`)
    }

    console.log(`[FinanceCallback] ${approval_type} ${approval_id}: ${decision} by ${decider_name}`)

    return NextResponse.json({
      status: 'ok',
      approval_id,
      approval_type,
      decision,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error'
    console.error(`[FinanceCallback] Error: ${msg}`)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

function verifyKey(key: string): boolean {
  try {
    return timingSafeEqual(Buffer.from(key), Buffer.from(INTEGRATION_API_KEY))
  } catch {
    return false
  }
}

function verifySignature(payload: string, signature: string): boolean {
  if (!INTEGRATION_WEBHOOK_SECRET) return false
  const expected = createHmac('sha256', INTEGRATION_WEBHOOK_SECRET).update(payload).digest('hex')
  try {
    return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))
  } catch {
    return false
  }
}
