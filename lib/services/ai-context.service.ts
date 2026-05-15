// ============================================================
// Trade OS — AI Context Cache Service
// 职责：构建并缓存 AI 使用的上下文，避免重复查询和 token 浪费
// 原则：cache-first，stale 时重建，支持手动失效
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { ok, err, type ServiceResult } from './types'
import { TERMINAL_LIFECYCLE_FILTER } from '@/lib/domain/lifecycleStatus'
import type {
  AIContextCache,
  ContextType,
  ContextResult,
  GetContextOptions,
} from './types'

// ── 缓存 TTL 默认值（小时）──────────────────────────────────
const DEFAULT_TTL_HOURS: Record<ContextType, number> = {
  customer: 24,   // 客户画像：每天刷新
  order: 6,       // 订单上下文：6小时，里程碑变化频繁
  factory: 72,    // 工厂档案：3天
  product: 48,    // 产品知识：2天
  global: 12,     // 全局上下文：12小时
}

// ── Token 估算（1 token ≈ 4 英文字符 / 2 中文字符）──────────
function estimateTokens(text: string): number {
  const chineseCount = (text.match(/[一-鿿]/g) || []).length
  const otherCount = text.length - chineseCount
  return Math.ceil(chineseCount / 2 + otherCount / 4)
}

// ─────────────────────────────────────────────────────────────
// getAIContextCache
// 读取缓存，自动判断是否 stale
// ─────────────────────────────────────────────────────────────
export async function getAIContextCache(
  supabase: SupabaseClient,
  contextType: ContextType,
  entityId: string,
  options?: GetContextOptions
): Promise<ServiceResult<ContextResult | null>> {
  if (options?.forceRefresh) {
    return ok(null)  // 强制刷新，跳过缓存
  }

  const { data, error } = await (supabase.from('ai_context_cache') as any)
    .select('*')
    .eq('context_type', contextType)
    .eq('entity_id', entityId)
    .maybeSingle()

  if (error) return err(error.message)
  if (!data) return ok(null)

  const cache = data as AIContextCache

  // 检查是否 stale
  if (cache.is_stale) return ok(null)

  // 检查 valid_until
  if (cache.valid_until && new Date(cache.valid_until) < new Date()) {
    return ok(null)
  }

  return ok({
    text: cache.raw_context_text ?? '',
    summaryJson: cache.summary_json,
    fromCache: true,
    tokenEstimate: cache.token_estimate,
    lastUpdatedAt: cache.last_updated_at,
  })
}

// ─────────────────────────────────────────────────────────────
// saveAIContextCache
// 写入/更新缓存
// ─────────────────────────────────────────────────────────────
export async function saveAIContextCache(
  supabase: SupabaseClient,
  contextType: ContextType,
  entityId: string,
  text: string,
  summaryJson: Record<string, any>,
  options?: { ttlHours?: number; modelUsed?: string }
): Promise<ServiceResult<void>> {
  const ttlHours = options?.ttlHours ?? DEFAULT_TTL_HOURS[contextType]
  const tokenEstimate = estimateTokens(text)
  const validUntil = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString()

  const { error } = await (supabase.from('ai_context_cache') as any)
    .upsert({
      context_type: contextType,
      entity_id: entityId,
      summary_json: summaryJson,
      raw_context_text: text,
      token_estimate: tokenEstimate,
      model_used: options?.modelUsed ?? null,
      last_updated_at: new Date().toISOString(),
      valid_until: validUntil,
      is_stale: false,
      invalidation_reason: null,
      version: 1,
    }, { onConflict: 'context_type,entity_id' })

  if (error) return err(error.message)
  return ok(undefined)
}

// ─────────────────────────────────────────────────────────────
// invalidateContextCache
// 手动标记失效（订单里程碑更新/客户信息变化时调用）
// ─────────────────────────────────────────────────────────────
export async function invalidateContextCache(
  supabase: SupabaseClient,
  contextType: ContextType,
  entityId: string,
  reason?: string
): Promise<ServiceResult<void>> {
  const { error } = await (supabase.from('ai_context_cache') as any)
    .update({
      is_stale: true,
      invalidation_reason: reason ?? '手动失效',
    })
    .eq('context_type', contextType)
    .eq('entity_id', entityId)

  if (error) return err(error.message)
  return ok(undefined)
}

// ─────────────────────────────────────────────────────────────
// buildCustomerContext
// 为 AI 构建客户上下文文字（包含历史订单、风险画像）
// ─────────────────────────────────────────────────────────────
export async function buildCustomerContext(
  supabase: SupabaseClient,
  customerName: string,
  options?: GetContextOptions
): Promise<ServiceResult<ContextResult>> {
  // 先查缓存
  const cached = await getAIContextCache(supabase, 'customer', customerName, options)
  if (cached.ok && cached.data) return ok(cached.data)

  // 缓存未命中 → 重新构建
  const [ordersRes, rhythmRes] = await Promise.allSettled([
    (supabase.from('orders') as any)
      .select('order_no, total_amount_usd, lifecycle_status, created_at, incoterm, order_type')
      .eq('customer_name', customerName)
      .order('created_at', { ascending: false })
      .limit(20),
    (supabase.from('customer_rhythm') as any)
      .select('*')
      .eq('customer_name', customerName)
      .maybeSingle(),
  ])

  const orders = ordersRes.status === 'fulfilled' ? (ordersRes.value.data || []) : []
  const rhythm = rhythmRes.status === 'fulfilled' ? rhythmRes.value.data : null

  // 构建结构化摘要
  const totalValue = orders.reduce((s: number, o: any) => s + (Number(o.total_amount_usd) || 0), 0)
  const activeOrders = orders.filter((o: any) =>
    !['completed', 'cancelled'].includes(o.lifecycle_status || '')
  )
  const recentOrders = orders.slice(0, 5)

  const summaryJson = {
    customerName,
    totalOrders: orders.length,
    activeOrders: activeOrders.length,
    totalValueUsd: totalValue,
    tier: rhythm?.tier ?? 'C',
    riskScore: rhythm?.risk_score ?? 0,
    followupStatus: rhythm?.followup_status ?? 'normal',
    lastContactAt: rhythm?.last_contact_at ?? null,
    recentOrderNos: recentOrders.map((o: any) => o.order_no),
  }

  // 构建文字上下文
  const lines: string[] = [
    `【客户档案：${customerName}】`,
    `- 客户等级：${rhythm?.tier ?? 'C'} 级`,
    `- 历史订单：${orders.length} 单，合计 $${Math.round(totalValue).toLocaleString()}`,
    `- 进行中订单：${activeOrders.length} 单`,
    `- 风险评分：${rhythm?.risk_score ?? 0}/100`,
    `- 跟进状态：${rhythm?.followup_status ?? '未知'}`,
    `- 最近联系：${rhythm?.last_contact_at ? new Date(rhythm.last_contact_at).toLocaleDateString('zh-CN') : '无记录'}`,
  ]

  if (recentOrders.length > 0) {
    lines.push('- 最近5单：')
    recentOrders.forEach((o: any) => {
      lines.push(`  · ${o.order_no}（${o.lifecycle_status}，$${Number(o.total_amount_usd || 0).toLocaleString()}）`)
    })
  }

  if (rhythm?.risk_factors?.length > 0) {
    lines.push('- 风险因素：' + rhythm.risk_factors.map((f: any) => f.description).join('；'))
  }

  const text = lines.join('\n')

  // 写入缓存
  await saveAIContextCache(supabase, 'customer', customerName, text, summaryJson, {
    ttlHours: options?.ttlHours ?? DEFAULT_TTL_HOURS.customer,
  })

  return ok({
    text,
    summaryJson,
    fromCache: false,
    tokenEstimate: estimateTokens(text),
    lastUpdatedAt: new Date().toISOString(),
  })
}

// ─────────────────────────────────────────────────────────────
// buildOrderContext
// 为 AI 构建订单上下文文字（包含里程碑、财务、延期历史）
// ─────────────────────────────────────────────────────────────
export async function buildOrderContext(
  supabase: SupabaseClient,
  orderId: string,
  options?: GetContextOptions
): Promise<ServiceResult<ContextResult>> {
  // 先查缓存
  const cached = await getAIContextCache(supabase, 'order', orderId, options)
  if (cached.ok && cached.data) return ok(cached.data)

  // 缓存未命中 → 重新构建
  const [orderRes, milestonesRes, delaysRes, financialsRes] = await Promise.allSettled([
    (supabase.from('orders') as any)
      .select('*')
      .eq('id', orderId)
      .single(),
    (supabase.from('milestones') as any)
      .select('step_key, step_name, status, planned_at, actual_at, owner_name')
      .eq('order_id', orderId)
      .order('planned_at', { ascending: true }),
    (supabase.from('delay_requests') as any)
      .select('original_date, new_proposed_date, reason, status, created_at')
      .eq('order_id', orderId)
      .order('created_at', { ascending: false })
      .limit(3),
    (supabase.from('order_financials') as any)
      .select('sale_total, sale_currency, cost_material, cost_cmt, cost_shipping')
      .eq('order_id', orderId)
      .maybeSingle(),
  ])

  const order = orderRes.status === 'fulfilled' ? orderRes.value.data : null
  if (!order) return err(`Order not found: ${orderId}`)

  const milestones = milestonesRes.status === 'fulfilled' ? (milestonesRes.value.data || []) : []
  const delays = delaysRes.status === 'fulfilled' ? (delaysRes.value.data || []) : []
  const financials = financialsRes.status === 'fulfilled' ? financialsRes.value.data : null

  // 里程碑完成情况
  const doneMilestones = milestones.filter((m: any) => m.status === 'done')
  const pendingMilestones = milestones.filter((m: any) => m.status === 'pending')
  const overdueMilestones = milestones.filter((m: any) =>
    m.status !== 'done' && m.planned_at && new Date(m.planned_at) < new Date()
  )

  const summaryJson = {
    orderId,
    orderNo: order.order_no,
    customerName: order.customer_name,
    lifecycleStatus: order.lifecycle_status,
    factoryDate: order.factory_date,
    quantity: order.quantity,
    milestonesTotal: milestones.length,
    milestonesDone: doneMilestones.length,
    milestonesOverdue: overdueMilestones.length,
    delayCount: delays.length,
    hasFinancials: !!financials,
  }

  // 构建文字上下文
  const lines: string[] = [
    `【订单档案：${order.order_no}】`,
    `- 客户：${order.customer_name}`,
    `- 状态：${order.lifecycle_status}`,
    `- 数量：${order.quantity} 件`,
    `- 出厂日：${order.factory_date ?? '未设定'}`,
    `- 里程碑：${doneMilestones.length}/${milestones.length} 完成，${overdueMilestones.length} 个逾期`,
  ]

  if (overdueMilestones.length > 0) {
    lines.push('- 逾期节点：' + overdueMilestones.map((m: any) => m.step_name).join('、'))
  }

  if (pendingMilestones.length > 0) {
    const next = pendingMilestones[0]
    lines.push(`- 下一节点：${next.step_name}（计划 ${next.planned_at ? new Date(next.planned_at).toLocaleDateString('zh-CN') : '未定'}，负责：${next.owner_name ?? '未分配'}）`)
  }

  if (delays.length > 0) {
    lines.push(`- 延期记录：${delays.length} 次`)
    const lastDelay = delays[0]
    lines.push(`  最近：${lastDelay.reason}（${lastDelay.status}）`)
  }

  if (financials) {
    const revenue = financials.sale_total
      ? `${financials.sale_currency || 'USD'} ${Number(financials.sale_total).toLocaleString()}`
      : '未录入'
    lines.push(`- 销售额：${revenue}`)
  }

  const text = lines.join('\n')

  // 写入缓存
  await saveAIContextCache(supabase, 'order', orderId, text, summaryJson, {
    ttlHours: options?.ttlHours ?? DEFAULT_TTL_HOURS.order,
  })

  return ok({
    text,
    summaryJson,
    fromCache: false,
    tokenEstimate: estimateTokens(text),
    lastUpdatedAt: new Date().toISOString(),
  })
}

// ─────────────────────────────────────────────────────────────
// buildGlobalContext
// 为 AI 构建全局业务上下文（公司/行业/规则摘要）
// ─────────────────────────────────────────────────────────────
export async function buildGlobalContext(
  supabase: SupabaseClient,
  options?: GetContextOptions
): Promise<ServiceResult<ContextResult>> {
  const cached = await getAIContextCache(supabase, 'global', 'system', options)
  if (cached.ok && cached.data) return ok(cached.data)

  // 全局上下文：公司基本信息 + 当前运营概况
  const [ordersCountRes, activeAlertsCountRes] = await Promise.allSettled([
    (supabase.from('orders') as any)
      .select('lifecycle_status')
      .not('lifecycle_status', 'in', TERMINAL_LIFECYCLE_FILTER),
    (supabase.from('system_alerts') as any)
      .select('id', { count: 'exact' })
      .eq('is_resolved', false),
  ])

  const activeOrderCount = ordersCountRes.status === 'fulfilled'
    ? (ordersCountRes.value.data || []).length : 0
  const activeAlertCount = activeAlertsCountRes.status === 'fulfilled'
    ? (activeAlertsCountRes.value.count || 0) : 0

  const summaryJson = {
    company: 'Qimo Activewear',
    industry: '运动服装出口',
    activeOrders: activeOrderCount,
    activeAlerts: activeAlertCount,
    updatedAt: new Date().toISOString(),
  }

  const text = [
    '【系统全局上下文】',
    '公司：启默运动（Qimo Activewear）',
    '行业：运动服装 OEM/ODM 出口',
    '主要市场：欧美、东南亚',
    `当前进行中订单：${activeOrderCount} 单`,
    `未处理系统告警：${activeAlertCount} 条`,
    '汇率参考：1 USD ≈ 7.2 CNY（以实际财务数据为准）',
    '利润预警线：毛利率 < 10% 为危险，< 15% 为预警',
  ].join('\n')

  await saveAIContextCache(supabase, 'global', 'system', text, summaryJson, {
    ttlHours: DEFAULT_TTL_HOURS.global,
  })

  return ok({
    text,
    summaryJson,
    fromCache: false,
    tokenEstimate: estimateTokens(text),
    lastUpdatedAt: new Date().toISOString(),
  })
}
