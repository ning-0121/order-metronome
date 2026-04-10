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
    approval_type: 'price' | 'delay' | 'cancel'
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
