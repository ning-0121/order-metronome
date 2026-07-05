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
    approval_type: 'price' | 'delay' | 'cancel' | 'milestone' | 'purchase'
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

  // H2(复审):审批回调幂等(防 5 分钟窗口内重放二次执行——尤其 purchase 二次下单、milestone 二次完成)。
  // claim-after:先查已处理过的 request_id → no-op;处理成功后再记(失败不记→可重试)。配合 purchase 状态闸双保险。
  const { createServiceRoleClient } = await import('@/lib/supabase/server')
  const svcIdem = createServiceRoleClient()
  if (payload.request_id) {
    try {
      const { data: seen } = await (svcIdem.from('integration_callback_events') as any)
        .select('request_id').eq('request_id', payload.request_id).maybeSingle()
      if (seen) return NextResponse.json({ status: 'ok', deduped: true })
    } catch (e) { console.warn('[finance-callback] 幂等查表异常(降级,靠状态闸兜底):', e instanceof Error ? e.message : e) }
  }

  try {
    const supabase = await createClient()

    // 4. 根据审批类型更新对应表。H2 复审:各分支加状态闸(仅"仍待审批"命中才落地),
    //    防不同 request_id 的重复回调覆盖已处理/已被人工修正的记录(request_id 幂等只挡同键重放)。
    const skipLog = (t: string) => console.log(`[FinanceCallback] ${t} ${approval_id}: 非待审批(重放/已处理/已人工改动),跳过`)
    if (approval_type === 'price') {
      const { data: rows, error } = await supabase
        .from('pre_order_price_approvals')
        .update({
          status: decision,
          review_note: decision_note ? `[财务系统-${decider_name}] ${decision_note}` : `[财务系统-${decider_name}] ${decision === 'approved' ? '审批通过' : '审批驳回'}`,
          reviewed_at: new Date().toISOString(),
        })
        .eq('id', approval_id).eq('status', 'pending').select('id')
      if (error) throw new Error(`Price approval update failed: ${error.message}`)
      if (!rows || rows.length === 0) skipLog('price')
    }

    if (approval_type === 'delay') {
      const { data: rows, error } = await supabase
        .from('delay_requests')
        .update({
          status: decision,
          decision_note: decision_note ? `[财务系统-${decider_name}] ${decision_note}` : `[财务系统-${decider_name}] ${decision === 'approved' ? '审批通过' : '审批驳回'}`,
          approved_at: new Date().toISOString(),
        })
        .eq('id', approval_id).eq('status', 'pending').select('id')
      if (error) throw new Error(`Delay approval update failed: ${error.message}`)
      if (!rows || rows.length === 0) skipLog('delay')
    }

    if (approval_type === 'cancel') {
      // H3:财务批准/驳回 → 真执行取消(service-role;decideCancel 内部 isApprovalPending 幂等,非 pending 返 error 即跳过)。
      // 批准:decideCancel 落 cancelled + 冻结里程碑 → finalizeCancelledOrder 作废 PO/执行行 + 清风险 + 通知财务/采购/生产。
      const { createServiceRoleClient } = await import('@/lib/supabase/server')
      const svc = createServiceRoleClient()
      const { decideCancel, finalizeCancelledOrder } = await import('@/lib/repositories/ordersRepo')
      const noteTag = decision_note ? `[财务系统-${decider_name}] ${decision_note}` : `[财务系统-${decider_name}] ${decision === 'approved' ? '已批准取消' : '驳回取消'}`
      const res = await decideCancel(approval_id, decision, noteTag, { supabase: svc, actorId: null })
      if (res.error) {
        console.log(`[FinanceCallback] cancel ${approval_id}: ${res.error}(幂等跳过)`)
      } else if (decision === 'approved') {
        const oid = (res.data as any)?.cancelRequest?.order_id
        if (oid) await finalizeCancelledOrder(svc, oid)
      }
    }

    // 里程碑审批（财务确认加工费/核准出运/收款等）。状态闸:已完成的不再被回调改动(防重放覆盖人工修正)。
    if (approval_type === 'milestone') {
      const newStatus = decision === 'approved' ? '已完成' : '阻塞'
      const { data: rows, error } = await supabase
        .from('milestones')
        .update({
          status: newStatus,
          actual_at: decision === 'approved' ? new Date().toISOString() : null,
          notes: decision_note ? `[财务系统-${decider_name}] ${decision_note}` : `[财务系统-${decider_name}] ${decision === 'approved' ? '财务已确认' : '财务驳回'}`,
        })
        .eq('id', approval_id).not('status', 'in', '("已完成","done","completed")').select('id')
      if (error) throw new Error(`Milestone update failed: ${error.message}`)
      if (!rows || rows.length === 0) skipLog('milestone')
      else {
        // 复审:此前财务确认里程碑直接写库、绕过 recompute 钩子 → 交付置信度滞后。补触发一次(fire-and-forget)。
        try {
          const { data: m } = await supabase.from('milestones').select('order_id').eq('id', approval_id).maybeSingle()
          const oid = (m as any)?.order_id
          if (oid) {
            const { recomputeDeliveryConfidence } = await import('@/app/actions/runtime-confidence')
            await recomputeDeliveryConfidence(oid, { type: 'milestone_status_changed', source: 'finance-callback:milestone', severity: 'info', payload: { milestone_id: approval_id, decision } })
          }
        } catch (e) { console.warn('[finance-callback] milestone recompute 失败(不阻断):', e instanceof Error ? e.message : e) }
      }
    }

    // 采购单审批(审计 B):approval_id=采购单 id。批准 → 自动下单(place core,emit purchase_order.placed);
    // 驳回 → 拦下并把原因给采购。用 service-role(无用户会话)。
    if (approval_type === 'purchase') {
      const { createServiceRoleClient } = await import('@/lib/supabase/server')
      const svc = createServiceRoleClient()
      const poNo = (payload.data as unknown as { po_no?: string }).po_no || approval_id
      const noteTag = decision_note ? `[财务系统-${decider_name}] ${decision_note}` : `[财务系统-${decider_name}] ${decision === 'approved' ? '已批准' : '已驳回'}`
      if (decision === 'approved') {
        // H2 状态闸:仅 pending → approved 命中 1 行才下单;命中 0 行(重放/已处理/已下单)→ 跳过,防二次下单。
        const { data: gate, error: upErr } = await (svc.from('purchase_orders') as any)
          .update({ approval_status: 'approved', approved_at: new Date().toISOString(), approval_note: noteTag, updated_at: new Date().toISOString() })
          .eq('id', approval_id).eq('approval_status', 'pending')
          .select('id')
        if (upErr) throw new Error(`PO approve update failed: ${upErr.message}`)
        if (!gate || gate.length === 0) {
          console.log(`[FinanceCallback] purchase approve: PO ${approval_id} 非 pending,跳过下单(幂等)`)
        } else {
          const { placePurchaseOrderCore } = await import('@/lib/procurement/placeCore')
          const pr = await placePurchaseOrderCore(svc, approval_id)
          if (pr.error) throw new Error(`PO place after approval failed: ${pr.error}`)
          try {
            const { notifyUsersByRole } = await import('@/lib/utils/notifications')
            await notifyUsersByRole(svc, ['procurement', 'procurement_manager'], {
              type: 'po_finance_approval', title: `✅ 采购单财务已批准,已自动下单：${poNo}`,
              message: `采购单 ${poNo} 已获财务批准并自动下单。`,
            })
          } catch { /* 通知失败不阻断 */ }
        }
      } else {
        // H2 状态闸:仅 pending → rejected 命中才通知;重放不重复通知/不改已下单单。
        const { data: gate, error: upErr } = await (svc.from('purchase_orders') as any)
          .update({ approval_status: 'rejected', approval_note: noteTag, updated_at: new Date().toISOString() })
          .eq('id', approval_id).eq('approval_status', 'pending')
          .select('id')
        if (upErr) throw new Error(`PO reject update failed: ${upErr.message}`)
        if (gate && gate.length > 0) {
          try {
            const { notifyUsersByRole } = await import('@/lib/utils/notifications')
            await notifyUsersByRole(svc, ['procurement', 'procurement_manager'], {
              type: 'po_finance_approval', title: `🔴 采购单被财务驳回：${poNo}`,
              message: `采购单 ${poNo} 被财务驳回:${decision_note || '无原因'}。请调整后重新提交。`,
            })
          } catch { /* 通知失败不阻断 */ }
        }
      }
    }

    // H2:处理成功后记幂等键(claim-after,失败不记→可重试)。表未建时静默(靠状态闸兜底)。
    if (payload.request_id) {
      try {
        await (svcIdem.from('integration_callback_events') as any)
          .insert({ request_id: payload.request_id, event: `approval.${approval_type}` })
      } catch (e) { console.warn('[finance-callback] 幂等记账失败(不影响回执):', e instanceof Error ? e.message : e) }
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
