// ============================================================
// Trade OS — Email Processor Service
// 职责：增量处理新邮件，AI 分析后写入 email_process_log
// 原则：幂等（email_uid 去重），增量（只处理未见过的）
//       token 节省（先匹配客户/订单，再构建精简上下文）
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { ok, err, type ServiceResult } from './types'
import type {
  RawEmail,
  EmailAnalysisResult,
  EmailProcessResult,
  EmailActionType,
  UrgencyLevel,
} from './types'
import { buildCustomerContext, buildOrderContext } from './ai-context.service'
import { createSystemAlert } from './alerts.service'

// ── 关键词快速预匹配（减少 AI 调用）────────────────────────────
const URGENT_KEYWORDS_ZH = ['紧急', '急', '立即', '马上', '今天必须', '出问题']
const URGENT_KEYWORDS_EN = ['urgent', 'asap', 'immediately', 'critical', 'rush', 'emergency']
const ACTION_KEYWORDS: Record<EmailActionType, string[]> = {
  inquiry: ['询价', '报价', 'quote', 'price', 'inquiry', 'sample', '打样', '产品'],
  followup: ['跟进', '进度', 'update', 'status', '什么时候', 'when'],
  complaint: ['投诉', '质量', '问题', 'complaint', 'defect', 'issue', 'wrong', '不对', '错误'],
  approval: ['确认', '同意', 'confirm', 'approve', 'approved', '批准'],
  payment: ['付款', '汇款', '发票', 'payment', 'invoice', 'wire', 'transfer'],
  info: ['通知', '更新', 'notice', 'inform', 'fyi', '请知悉'],
  other: [],
  none: [],
}

// ─────────────────────────────────────────────────────────────
// isEmailProcessed
// 检查邮件是否已处理（防重复）
// ─────────────────────────────────────────────────────────────
export async function isEmailProcessed(
  supabase: SupabaseClient,
  emailUid: string
): Promise<boolean> {
  const { data } = await (supabase.from('email_process_log') as any)
    .select('id')
    .eq('email_uid', emailUid)
    .maybeSingle()
  return !!data
}

// ─────────────────────────────────────────────────────────────
// quickClassifyEmail
// 纯函数：基于关键词快速分类（不调用 AI）
// ─────────────────────────────────────────────────────────────
export function quickClassifyEmail(email: RawEmail): {
  urgencyLevel: UrgencyLevel
  likelyActionType: EmailActionType
  customerHint: string | null
  orderHint: string | null
} {
  const text = `${email.subject} ${email.body}`.toLowerCase()

  // 紧急度判断
  const isUrgent =
    URGENT_KEYWORDS_ZH.some(k => text.includes(k)) ||
    URGENT_KEYWORDS_EN.some(k => text.includes(k))

  // 动作类型判断（取第一个匹配的）
  let likelyActionType: EmailActionType = 'other'
  for (const [actionType, keywords] of Object.entries(ACTION_KEYWORDS)) {
    if (keywords.some(k => text.includes(k.toLowerCase()))) {
      likelyActionType = actionType as EmailActionType
      break
    }
  }

  // 订单号识别（格式：QM-YYYYMMDD-NNN 或 纯数字）
  const orderMatch = text.match(/(?:qm[-_]?\d{8}[-_]?\d{3}|\border\s*(?:no|number|#)?\s*[:：]?\s*(\w+))/i)
  const orderHint = orderMatch ? orderMatch[0] : null

  // 发件人邮箱提取客户线索
  const emailDomain = email.from.split('@')[1]?.split('>')[0]
  const customerHint = emailDomain && !['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com'].includes(emailDomain)
    ? emailDomain
    : null

  return {
    urgencyLevel: isUrgent ? 'urgent' : 'normal',
    likelyActionType,
    customerHint,
    orderHint,
  }
}

// ─────────────────────────────────────────────────────────────
// detectEntities
// 从 DB 中确认客户和订单（比 AI 更精准、更省 token）
// ─────────────────────────────────────────────────────────────
async function detectEntities(
  supabase: SupabaseClient,
  email: RawEmail,
  hints: { customerHint: string | null; orderHint: string | null }
): Promise<{ customerName: string | null; orderId: string | null; orderNo: string | null }> {
  let customerName: string | null = null
  let orderId: string | null = null
  let orderNo: string | null = null

  // 尝试订单号匹配
  if (hints.orderHint) {
    const { data } = await (supabase.from('orders') as any)
      .select('id, order_no, customer_name')
      .ilike('order_no', `%${hints.orderHint.replace(/[-_]/g, '%')}%`)
      .limit(1)
      .maybeSingle()

    if (data) {
      orderId = data.id
      orderNo = data.order_no
      customerName = data.customer_name
    }
  }

  // 尝试从发件人邮箱匹配客户
  if (!customerName && hints.customerHint) {
    const { data } = await (supabase.from('customer_rhythm') as any)
      .select('customer_name')
      .ilike('customer_name', `%${hints.customerHint.split('.')[0]}%`)
      .limit(1)
      .maybeSingle()

    if (data) customerName = data.customer_name
  }

  // 尝试从邮件正文匹配已知客户名
  if (!customerName) {
    const { data: customers } = await (supabase.from('customer_rhythm') as any)
      .select('customer_name')
      .limit(50)

    const emailText = `${email.subject} ${email.body}`.toLowerCase()
    for (const row of customers || []) {
      if (emailText.includes(row.customer_name.toLowerCase())) {
        customerName = row.customer_name
        break
      }
    }
  }

  return { customerName, orderId, orderNo }
}

// ─────────────────────────────────────────────────────────────
// analyzeEmailWithContext
// 调用 AI 对邮件做深度分析（需要传入 AI 客户端）
// 设计为可替换：目前返回规则引擎结果，AI 接入后升级
// ─────────────────────────────────────────────────────────────
export async function analyzeEmailWithContext(
  supabase: SupabaseClient,
  email: RawEmail,
  customerName: string | null,
  orderId: string | null
): Promise<EmailAnalysisResult> {
  // 快速分类（规则引擎）
  const quick = quickClassifyEmail(email)

  // 构建上下文（用于 AI，目前只做 token 估算）
  let contextTokens = 0
  if (customerName) {
    const ctx = await buildCustomerContext(supabase, customerName)
    if (ctx.ok) contextTokens += ctx.data.tokenEstimate
  }
  if (orderId) {
    const ctx = await buildOrderContext(supabase, orderId)
    if (ctx.ok) contextTokens += ctx.data.tokenEstimate
  }

  // TODO: 接入 Anthropic Claude API 时，在这里发起 AI 调用
  // 当前使用规则引擎的结果作为 fallback
  const requiresAction = ['inquiry', 'complaint', 'approval', 'payment'].includes(quick.likelyActionType)

  let actionDescription: string | null = null
  if (quick.likelyActionType === 'inquiry') actionDescription = '需要回复询价/报价'
  else if (quick.likelyActionType === 'complaint') actionDescription = '客户投诉，需要立即跟进'
  else if (quick.likelyActionType === 'approval') actionDescription = '等待确认/审批'
  else if (quick.likelyActionType === 'payment') actionDescription = '付款相关，需财务处理'

  return {
    actionType: quick.likelyActionType,
    urgencyLevel: quick.urgencyLevel,
    customerDetected: customerName,
    orderDetected: orderId,
    summaryText: `[${quick.likelyActionType}] ${email.subject}${customerName ? `（${customerName}）` : ''}`,
    requiresAction,
    actionDescription,
    tokenUsed: contextTokens + Math.ceil(email.body.length / 4), // 估算
  }
}

// ─────────────────────────────────────────────────────────────
// processSingleEmail
// 处理单封邮件（幂等：已处理过的跳过）
// ─────────────────────────────────────────────────────────────
export async function processSingleEmail(
  supabase: SupabaseClient,
  email: RawEmail
): Promise<ServiceResult<{ skipped: boolean; requiresAction: boolean }>> {
  try {
    // 1. 幂等检查
    const processed = await isEmailProcessed(supabase, email.uid)
    if (processed) return ok({ skipped: true, requiresAction: false })

    // 2. 快速分类
    const quick = quickClassifyEmail(email)

    // 3. 实体识别
    const { customerName, orderId, orderNo } = await detectEntities(supabase, email, {
      customerHint: quick.customerHint,
      orderHint: quick.orderHint,
    })

    // 4. AI 分析（当前为规则引擎）
    const analysis = await analyzeEmailWithContext(supabase, email, customerName, orderId)

    // 5. 写入处理日志
    const { error: logErr } = await (supabase.from('email_process_log') as any)
      .insert({
        email_uid: email.uid,
        message_id: email.messageId ?? null,
        subject: email.subject,
        from_email: email.from,
        received_at: email.receivedAt.toISOString(),
        processed_at: new Date().toISOString(),
        customer_detected: analysis.customerDetected,
        order_detected: orderNo ?? analysis.orderDetected,
        action_type: analysis.actionType,
        urgency_level: analysis.urgencyLevel,
        summary_text: analysis.summaryText,
        requires_action: analysis.requiresAction,
        action_description: analysis.actionDescription,
        token_used: analysis.tokenUsed,
        model_used: 'rule-engine',
      })

    if (logErr && logErr.code !== '23505') {  // 23505 = 唯一约束冲突（正常）
      return err(`Failed to log email: ${logErr.message}`)
    }

    // 6. 紧急邮件 → 创建系统告警
    if (analysis.urgencyLevel === 'urgent' && analysis.requiresAction) {
      await createSystemAlert(supabase, {
        alertType: 'email_urgent',
        severity: 'critical',
        entityType: customerName ? 'customer' : 'system',
        entityId: customerName ?? undefined,
        title: `📧 紧急邮件：${email.subject}`,
        description: `${analysis.actionDescription ?? '需要处理'}${customerName ? `（${customerName}）` : ''}`,
        data: {
          emailUid: email.uid,
          subject: email.subject,
          fromEmail: email.from,
          customerName,
          orderId,
          actionType: analysis.actionType,
        },
        autoResolveHours: 24,
      })
    }

    return ok({ skipped: false, requiresAction: analysis.requiresAction })
  } catch (e: any) {
    // 写入错误日志（不阻断批量处理）
    await (supabase.from('email_process_log') as any)
      .insert({
        email_uid: email.uid,
        subject: email.subject,
        from_email: email.from,
        received_at: email.receivedAt.toISOString(),
        processed_at: new Date().toISOString(),
        urgency_level: 'normal',
        requires_action: false,
        token_used: 0,
        error_message: e?.message ?? 'unknown error',
      })
      .then(() => {})  // fire-and-forget

    return err(`processSingleEmail exception: ${e?.message}`)
  }
}

// ─────────────────────────────────────────────────────────────
// processNewEmailsOnly
// 主入口：批量处理新邮件数组（增量，已处理的自动跳过）
// ─────────────────────────────────────────────────────────────
export async function processNewEmailsOnly(
  supabase: SupabaseClient,
  emails: RawEmail[]
): Promise<ServiceResult<EmailProcessResult>> {
  let processed = 0
  let skipped = 0
  let tokensUsed = 0
  let actionsFound = 0
  const errors: string[] = []

  // 串行处理（避免并发写入冲突 + 控制 API token 消耗）
  for (const email of emails) {
    const result = await processSingleEmail(supabase, email)

    if (result.ok) {
      if (result.data.skipped) {
        skipped++
      } else {
        processed++
        if (result.data.requiresAction) actionsFound++
      }
    } else {
      errors.push(`[${email.uid}] ${result.error}`)
    }
  }

  return ok({ processed, skipped, tokensUsed, actionsFound, errors })
}

// ─────────────────────────────────────────────────────────────
// getRecentEmailLogs
// 读取最近的处理日志（用于邮件工作台展示）
// ─────────────────────────────────────────────────────────────
export async function getRecentEmailLogs(
  supabase: SupabaseClient,
  options?: {
    requiresActionOnly?: boolean
    customerName?: string
    limit?: number
  }
) {
  let query = (supabase.from('email_process_log') as any)
    .select('*')
    .order('received_at', { ascending: false })
    .limit(options?.limit ?? 50)

  if (options?.requiresActionOnly) {
    query = query.eq('requires_action', true)
  }
  if (options?.customerName) {
    query = query.eq('customer_detected', options.customerName)
  }

  const { data, error } = await query
  if (error) return err(error.message)
  return ok(data)
}
