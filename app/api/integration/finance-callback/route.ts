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

/**
 * 采购付款申请回传(P2):财务付完某笔 payable(source_ref=付款申请 id)→ 标付款申请已付 +
 * 累加对账单 paid_amount;付满净应付则对账 status=paid。service-role 写(绕 RLS)。幂等由上层
 * request_id 去重保证(重放不会重复进来)。
 */
async function applyProcurementPayment(svc: any, prId: string, amount: number) {
  const { data: pr } = await svc.from('procurement_payment_requests')
    .select('id, reconciliation_id, paid_amount, amount').eq('id', prId).maybeSingle()
  if (!pr) return   // 非采购付款申请(可能是别的应付),忽略
  const now = new Date().toISOString()
  await svc.from('procurement_payment_requests')
    .update({ status: 'paid', paid_amount: (Number(pr.paid_amount) || 0) + amount, paid_at: now, updated_at: now })
    .eq('id', prId)
  const { data: recon } = await svc.from('procurement_reconciliations')
    .select('id, paid_amount, net_payable, status').eq('id', pr.reconciliation_id).maybeSingle()
  if (!recon) return
  const newPaid = (Number(recon.paid_amount) || 0) + amount
  const fullyPaid = newPaid + 0.01 >= (Number(recon.net_payable) || 0) && (Number(recon.net_payable) || 0) > 0
  await svc.from('procurement_reconciliations').update({
    paid_amount: newPaid, ...(fullyPaid ? { status: 'paid', paid_at: now } : {}), updated_at: now,
  }).eq('id', pr.reconciliation_id)
}

/**
 * 财务「改判」止血(2026-07-27 CEO)。财务批准后又撤销重审再驳回(或反之)→ 回传裁决与节拍器现状相悖。
 * 状态闸(.eq status pending 等)本会静默跳过(防重放),但那样节拍器毫不知情、订单不被差回。
 * 此处:现状与本次裁决**明确相悖**(非重放)→ 通知采购/业务/财务人工核撤(不自动硬撤副作用,避免误撤)。
 * currentDecision 传已归一的 'approved'|'rejected'|null;null 或与 incoming 相同 → 视为重放/未处理,不报。
 */
async function flagFinanceReversal(svc: any, opts: {
  approvalLabel: string; refNo: string; incoming: 'approved' | 'rejected';
  currentDecision: 'approved' | 'rejected' | null; deciderName: string; note: string | null; relatedOrderId: string | null;
}): Promise<boolean> {
  const { approvalLabel, refNo, incoming, currentDecision, deciderName, note, relatedOrderId } = opts
  if (!currentDecision || currentDecision === incoming) return false
  try {
    const { notifyUsersByRole } = await import('@/lib/utils/notifications')
    await notifyUsersByRole(svc, ['procurement', 'procurement_manager', 'sales', 'merchandiser', 'order_manager', 'finance'], {
      type: 'finance_reversal',
      title: `⚠️ 财务改判${approvalLabel} ${refNo}:原${currentDecision === 'approved' ? '批准' : '驳回'}→现${incoming === 'approved' ? '批准' : '驳回'}`,
      message: `财务(${deciderName})对已处理的${approvalLabel} ${refNo} 改判为「${incoming === 'approved' ? '批准' : '驳回'}」${note ? ':' + note : ''}。节拍器为防误撤未自动执行,请人工核对并处理(作废/恢复采购单、卡回/放行出货、差回订单等)。`,
      relatedOrderId: relatedOrderId || undefined,
    })
    console.log(`[FinanceCallback] ⚠️ 改判止血通知已发:${approvalLabel} ${refNo} ${currentDecision}→${incoming}`)
  } catch (e) { console.warn('[finance-callback] 改判通知失败:', e instanceof Error ? e.message : e) }
  return true
}

interface ApprovalCallback {
  event: string
  timestamp: string
  source: string
  request_id: string
  data: {
    approval_id: string
    // P0-4 修复：补 'milestone'。L106 实际处理这种类型（财务确认加工费/核准出运/收款等里程碑）
    // 但 union 之前漏写，导致 TS 判类型不重叠、IDE 提示死代码
    approval_type: 'price' | 'cancel' | 'milestone' | 'purchase' | 'shipment' | 'order_purpose'
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
  const FINANCE_PROGRESS = new Set(['settlement.closed', 'collection.received', 'payment.completed', 'budget.confirmed'])
  const evt = (payload as unknown as { event?: string }).event || ''
  if (FINANCE_PROGRESS.has(evt)) {
    const d = payload.data as unknown as { qimo_order_id?: string; order_no?: string; amount?: number; currency?: string; note?: string; at?: string; source_ref?: string }
    try {
      // 审计 A4:改用 service-role 写(绕过 RLS,配合去掉 anon INSERT 策略);
      // 幂等键 request_id + onConflict DO NOTHING → 5 分钟窗口内重放同一回调不重复记账。
      const { createServiceRoleClient } = await import('@/lib/supabase/server')
      const svc = createServiceRoleClient()
      // 幂等(P2):该 request_id 已记过 → 已处理,直接 ok(付款回传重放不重复累加对账已付)。
      if (payload.request_id) {
        const { data: seen } = await (svc.from('order_finance_events') as any).select('id').eq('request_id', payload.request_id).maybeSingle()
        if (seen) return NextResponse.json({ status: 'ok', recorded: evt, dedup: true })
      }
      // order_id 兜底(审计P1修复):财务发的 qimo_order_id 可能为空(旧映射丢字段),
      // 按 order_no/internal_order_no 反查 orders.id —— 否则 budget.confirmed 挂不上订单,硬闸门永不放行。
      let resolvedOrderId = d.qimo_order_id || null
      if (!resolvedOrderId && d.order_no) {
        const on = String(d.order_no)
        const { data: ord } = await (svc.from('orders') as any)
          .select('id').or(`order_no.eq.${on},internal_order_no.eq.${on}`).limit(1).maybeSingle()
        if (ord?.id) resolvedOrderId = ord.id as string
      }
      // 幂等硬化(审计 2026-08-19):request_id 唯一索引已建(迁移 20260819_order_finance_events_
      // request_id_unique)。此前 select-then-insert 在 5 分钟签名窗口内并发重放会双插 →
      // applyProcurementPayment 把对账已付累加两遍。现在 insert 撞唯一索引即判定为重放,
      // 只有【真实插入成功】才执行付款累加副作用。
      const insRes = await (svc.from('order_finance_events') as unknown as { insert: (v: unknown) => { select: (c: string) => Promise<{ data: unknown[] | null; error: { message: string; code?: string } | null }> } }).insert({
        request_id: payload.request_id || null,
        order_id: resolvedOrderId,
        order_no: d.order_no || null,
        event_type: evt,
        amount: d.amount ?? null,
        currency: d.currency || null,
        note: d.note || null,
        occurred_at: d.at || new Date().toISOString(),
      }).select('id')
      if (insRes.error) {
        // 23505 唯一冲突 = 并发重放,幂等吞并(与上面 seen-check 同语义);索引未建时不会走到这
        if (insRes.error.code === '23505' || /duplicate key|order_finance_events_request_id_uniq/i.test(insRes.error.message)) {
          return NextResponse.json({ status: 'ok', recorded: evt, dedup: true })
        }
        throw new Error(insRes.error.message)
      }
      // 采购付款申请回传(P2):payment.completed 带 source_ref → 累加对账已付、标付款申请已付。
      // 仅在真实插入后执行(重放已在上面被吞并),杜绝双计。
      if (evt === 'payment.completed' && d.source_ref) {
        await applyProcurementPayment(svc, String(d.source_ref), Number(d.amount) || 0)
      }
      return NextResponse.json({ status: 'ok', recorded: evt })
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
    // 修 P0/P1(2026-07-09 审计):回调无用户登录会话,匿名 createClient() 下 auth.uid()=NULL,
    // price/delay/milestone 三表的 UPDATE 会被 RLS 静默挡成 0 行 → 财务批过的审批永久写不回、订单卡死。
    // 统一走 service-role(与 cancel/purchase 分支一致);状态闸 .eq('status','pending') 保留做幂等。
    const { createServiceRoleClient } = await import('@/lib/supabase/server')
    const supabase = createServiceRoleClient()

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
      if (!rows || rows.length === 0) {
        skipLog('price')
        // 改判止血(2026-07-28 审计 P1-1):601B 场景——财务批准→撤销→驳回,第一次已落地则第二次改判被状态闸吞掉。
        const { data: cur } = await supabase.from('pre_order_price_approvals').select('status').eq('id', approval_id).maybeSingle()
        const curDec = (cur as any)?.status === 'approved' ? 'approved' as const : (cur as any)?.status === 'rejected' ? 'rejected' as const : null
        await flagFinanceReversal(supabase, { approvalLabel: '价格审批', refNo: String(approval_id).slice(0, 8), incoming: decision, currentDecision: curDec, deciderName: decider_name, note: decision_note, relatedOrderId: null })
      }
    }

    // (delay 审批回调已移除 2026-07-09:改期只走节拍器内部审批链,从不推财务→此分支永不触发,删幽灵能力)

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
        // 改判止血(2026-07-28 审计 P1-1):已批准执行取消后财务又驳回(或反向)→ 通知人工核对
        const { data: cur } = await (svc.from('cancel_requests') as any).select('status, order_id').eq('id', approval_id).maybeSingle()
        const curDec = (cur as any)?.status === 'approved' ? 'approved' as const : (cur as any)?.status === 'rejected' ? 'rejected' as const : null
        await flagFinanceReversal(svc, { approvalLabel: '取消审批', refNo: String(approval_id).slice(0, 8), incoming: decision, currentDecision: curDec, deciderName: decider_name, note: decision_note, relatedOrderId: (cur as any)?.order_id ?? null })
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
      if (!rows || rows.length === 0) {
        skipLog('milestone')
        // 改判止血(2026-07-28 审计 P1-1):节点已完成后财务改判驳回 → 不自动差回,通知人工核对
        if (decision === 'rejected') {
          const { data: cur } = await supabase.from('milestones').select('order_id, name, status').eq('id', approval_id).maybeSingle()
          const done = ['已完成', 'done', 'completed'].includes(String((cur as any)?.status || ''))
          await flagFinanceReversal(supabase, { approvalLabel: `里程碑确认(${(cur as any)?.name || ''})`, refNo: String(approval_id).slice(0, 8), incoming: 'rejected', currentDecision: done ? 'approved' : null, deciderName: decider_name, note: decision_note, relatedOrderId: (cur as any)?.order_id ?? null })
        }
      } else {
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

    // 出货财务审批:approval_id=shipment_confirmations.id。批准 → warehouse_signed(放行物流执行);
    //   驳回 → pending(退回业务)。状态闸:仅 sales_signed → 命中才改,防重放/已处理二次覆盖。
    if (approval_type === 'shipment') {
      const noteTag = decision_note
        ? `[财务系统-${decider_name}] ${decision_note}`
        : `[财务系统-${decider_name}] ${decision === 'approved' ? '审批通过' : '审批驳回'}`
      const patch: Record<string, unknown> = {
        finance_signed_at: new Date().toISOString(),
        finance_decision: decision,
        finance_decision_note: noteTag,
        status: decision === 'approved' ? 'warehouse_signed' : 'pending',
      }
      if (decision === 'rejected') patch.finance_note = `驳回: ${decision_note || ''}`
      const { data: rows, error } = await supabase
        .from('shipment_confirmations')
        .update(patch)
        .eq('id', approval_id).eq('status', 'sales_signed').select('id, order_id')
      if (error) throw new Error(`Shipment approval update failed: ${error.message}`)
      // 外部财务批准 = 主审批路径 → 必须与站内审批产生完全一致的结果:开 allow_shipment 放货闸 + A2 审计。
      // 否则外部批了、闸仍关,shipment_execute 永远卡死(两套审批真相)。走统一放货 Command。
      if (decision === 'approved' && rows && rows.length > 0) {
        const oid = (rows[0] as any).order_id
        if (oid) {
          const { approveShipmentRelease } = await import('@/lib/shipment/approve-release')
          const rel = await approveShipmentRelease(supabase, {
            orderId: oid, approvedBy: decider_name || 'external_finance', source: 'external_finance',
            externalReference: decider_name || null, reason: decision_note || null,
          })
          if (!rel.ok) throw new Error(`外部财务放货开闸失败(${rel.status}): ${rel.error}`)
        }
      }
      if (!rows || rows.length === 0) {
        skipLog('shipment')
        // 改判止血:当前 finance_decision 与本次相悖(如原批准放行、现驳回)→ 通知人工核撤
        const { data: cur } = await (supabase.from('shipment_confirmations') as any)
          .select('finance_decision, order_id').eq('id', approval_id).maybeSingle()
        const curDec = (cur as any)?.finance_decision === 'approved' ? 'approved' : (cur as any)?.finance_decision === 'rejected' ? 'rejected' : null
        await flagFinanceReversal(supabase, { approvalLabel: '出货审批', refNo: String(approval_id).slice(0, 8), incoming: decision, currentDecision: curDec, deciderName: decider_name, note: decision_note, relatedOrderId: (cur as any)?.order_id ?? null })
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
          // 改判止血:当前已驳回、现回传批准 → 通知人工核恢复
          const { data: cur } = await (svc.from('purchase_orders') as any).select('approval_status, order_ids').eq('id', approval_id).maybeSingle()
          const curDec = (cur as any)?.approval_status === 'approved' ? 'approved' : (cur as any)?.approval_status === 'rejected' ? 'rejected' : null
          await flagFinanceReversal(svc, { approvalLabel: '采购单', refNo: poNo, incoming: 'approved', currentDecision: curDec, deciderName: decider_name, note: decision_note, relatedOrderId: ((cur as any)?.order_ids || [])[0] ?? null })
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
        } else {
          // 改判止血:当前已批准下单、现回传驳回(撤销重审后驳回)→ 通知人工作废采购单、差回订单
          const { data: cur } = await (svc.from('purchase_orders') as any).select('approval_status, order_ids').eq('id', approval_id).maybeSingle()
          const curDec = (cur as any)?.approval_status === 'approved' ? 'approved' : (cur as any)?.approval_status === 'rejected' ? 'rejected' : null
          await flagFinanceReversal(svc, { approvalLabel: '采购单', refNo: poNo, incoming: 'rejected', currentDecision: curDec, deciderName: decider_name, note: decision_note, relatedOrderId: ((cur as any)?.order_ids || [])[0] ?? null })
        }
      }
    }

    // 订单用途变更审批(2026-07-15):approval_id = order_purpose_change_requests.id。
    // 批准 → 执行改用途+温和重算里程碑(记财务审批人名进 note);驳回 → 标 rejected。
    // 状态闸 .eq('status','pending') 幂等,防重放二次执行。
    if (approval_type === 'order_purpose') {
      const { createServiceRoleClient } = await import('@/lib/supabase/server')
      const svc = createServiceRoleClient()
      const { data: req } = await (svc.from('order_purpose_change_requests') as any)
        .select('id, order_id, to_purpose, reason, status').eq('id', approval_id).maybeSingle()
      if (!req || (req as any).status !== 'pending') {
        skipLog('order_purpose')
        // 改判止血(2026-07-28 审计 P1-1):用途变更已裁决落地后财务改判 → 通知人工核对(不自动改回用途)
        if (req) {
          const curDec = (req as any).status === 'approved' ? 'approved' as const : (req as any).status === 'rejected' ? 'rejected' as const : null
          await flagFinanceReversal(svc, { approvalLabel: '订单改用途', refNo: String(approval_id).slice(0, 8), incoming: decision, currentDecision: curDec, deciderName: decider_name, note: decision_note, relatedOrderId: (req as any).order_id ?? null })
        }
      } else {
        const now = new Date().toISOString()
        const noteTag = decision_note
          ? `[财务系统-${decider_name}] ${decision_note}`
          : `[财务系统-${decider_name}] ${decision === 'approved' ? '已批准改用途' : '驳回改用途'}`
        if (decision === 'approved') {
          const { applyOrderPurposeChangeFromCallback } = await import('@/app/actions/orders')
          const applied = await applyOrderPurposeChangeFromCallback(
            (req as any).order_id, (req as any).to_purpose,
            `财务审批·${decider_name}${decision_note ? ':' + decision_note : ''}`,
          )
          if (applied.error) throw new Error(`用途变更执行失败: ${applied.error}`)
          const { data: gate } = await (svc.from('order_purpose_change_requests') as any)
            .update({ status: 'approved', decided_at: now, decision_note: noteTag, updated_at: now })
            .eq('id', approval_id).eq('status', 'pending').select('id')
          if (!gate || gate.length === 0) skipLog('order_purpose')
        } else {
          const { data: gate } = await (svc.from('order_purpose_change_requests') as any)
            .update({ status: 'rejected', decided_at: now, decision_note: noteTag, updated_at: now })
            .eq('id', approval_id).eq('status', 'pending').select('id')
          if (!gate || gate.length === 0) skipLog('order_purpose')
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
