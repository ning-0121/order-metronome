// ============================================================
// Trade OS — Customer Rhythm Service
// 职责：跟踪客户跟进节奏，计算风险评分，触发跟进提醒
// 原则：数据来自 orders 聚合，写入 customer_rhythm
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { ok, err, type ServiceResult } from './types'
import type {
  CustomerRhythm,
  CustomerTier,
  FollowupStatus,
  RiskFactor,
  CustomerRhythmSyncResult,
} from './types'
import { createSystemAlert, resolveAlertByKey } from './alerts.service'

// ── 客户分级阈值 ──────────────────────────────────────────────
const TIER_THRESHOLDS = {
  A: { minValue: 100000, minCount: 5 },   // 战略客户：累计>10万美元 或 >=5单
  B: { minValue: 30000, minCount: 2 },    // 重要客户：累计>3万美元 或 >=2单
  // C: 其余
} as const

// ── 跟进间隔默认值（天）──────────────────────────────────────
const DEFAULT_FOLLOWUP_INTERVALS: Record<CustomerTier, number> = {
  A: 7,   // 战略客户：每周跟进
  B: 14,  // 重要客户：两周跟进
  C: 30,  // 普通客户：每月跟进
}

// ── 风险评分权重 ──────────────────────────────────────────────
const RISK_WEIGHTS = {
  NO_ORDER_90_DAYS: 30,     // 90天无新订单
  NO_ORDER_60_DAYS: 15,     // 60天无新订单
  NO_CONTACT_30_DAYS: 25,   // 30天未联系
  NO_CONTACT_14_DAYS: 10,   // 14天未联系
  OVERDUE_FOLLOWUP: 20,     // 跟进逾期
  SINGLE_ORDER: 10,          // 只有一单（流失风险高）
  DECLINING_VALUE: 15,       // 最近订单价值下降
} as const

// ─────────────────────────────────────────────────────────────
// calculateCustomerTier
// 纯函数：根据历史数据判断客户等级
// ─────────────────────────────────────────────────────────────
export function calculateCustomerTier(
  totalValueUsd: number,
  orderCount: number,
  lastOrderDaysAgo: number | null
): CustomerTier {
  // 超过180天无订单降级处理
  const inactive = lastOrderDaysAgo !== null && lastOrderDaysAgo > 180

  if (!inactive) {
    if (totalValueUsd >= TIER_THRESHOLDS.A.minValue || orderCount >= TIER_THRESHOLDS.A.minCount) {
      return 'A'
    }
    if (totalValueUsd >= TIER_THRESHOLDS.B.minValue || orderCount >= TIER_THRESHOLDS.B.minCount) {
      return 'B'
    }
  }
  return 'C'
}

// ─────────────────────────────────────────────────────────────
// calculateRiskScore
// 纯函数：0-100 风险评分，越高越危险
// ─────────────────────────────────────────────────────────────
export function calculateRiskScore(params: {
  lastContactDaysAgo: number | null
  lastOrderDaysAgo: number | null
  followupStatus: FollowupStatus
  orderCount: number
  avgOrderValueUsd: number
  lastOrderValueUsd: number | null
}): { score: number; factors: RiskFactor[] } {
  const {
    lastContactDaysAgo,
    lastOrderDaysAgo,
    followupStatus,
    orderCount,
    avgOrderValueUsd,
    lastOrderValueUsd,
  } = params

  let score = 0
  const factors: RiskFactor[] = []

  // 无订单风险
  if (lastOrderDaysAgo !== null) {
    if (lastOrderDaysAgo > 90) {
      score += RISK_WEIGHTS.NO_ORDER_90_DAYS
      factors.push({
        type: 'no_order',
        description: `${Math.floor(lastOrderDaysAgo)}天未下单`,
        weight: RISK_WEIGHTS.NO_ORDER_90_DAYS,
      })
    } else if (lastOrderDaysAgo > 60) {
      score += RISK_WEIGHTS.NO_ORDER_60_DAYS
      factors.push({
        type: 'no_order',
        description: `${Math.floor(lastOrderDaysAgo)}天未下单`,
        weight: RISK_WEIGHTS.NO_ORDER_60_DAYS,
      })
    }
  } else {
    // 从未下单（新客户）
    score += RISK_WEIGHTS.NO_ORDER_60_DAYS
    factors.push({
      type: 'no_order',
      description: '尚未成交',
      weight: RISK_WEIGHTS.NO_ORDER_60_DAYS,
    })
  }

  // 联系频率风险
  if (lastContactDaysAgo !== null) {
    if (lastContactDaysAgo > 30) {
      score += RISK_WEIGHTS.NO_CONTACT_30_DAYS
      factors.push({
        type: 'no_contact',
        description: `${Math.floor(lastContactDaysAgo)}天未联系`,
        weight: RISK_WEIGHTS.NO_CONTACT_30_DAYS,
      })
    } else if (lastContactDaysAgo > 14) {
      score += RISK_WEIGHTS.NO_CONTACT_14_DAYS
      factors.push({
        type: 'no_contact',
        description: `${Math.floor(lastContactDaysAgo)}天未联系`,
        weight: RISK_WEIGHTS.NO_CONTACT_14_DAYS,
      })
    }
  }

  // 跟进逾期
  if (followupStatus === 'overdue' || followupStatus === 'at_risk') {
    score += RISK_WEIGHTS.OVERDUE_FOLLOWUP
    factors.push({
      type: 'followup_overdue',
      description: '跟进逾期，需立即联系',
      weight: RISK_WEIGHTS.OVERDUE_FOLLOWUP,
    })
  }

  // 单次客户风险
  if (orderCount === 1) {
    score += RISK_WEIGHTS.SINGLE_ORDER
    factors.push({
      type: 'single_order',
      description: '仅有一单，流失风险高',
      weight: RISK_WEIGHTS.SINGLE_ORDER,
    })
  }

  // 订单价值下降风险
  if (lastOrderValueUsd !== null && avgOrderValueUsd > 0 && orderCount > 2) {
    if (lastOrderValueUsd < avgOrderValueUsd * 0.5) {
      score += RISK_WEIGHTS.DECLINING_VALUE
      factors.push({
        type: 'declining_value',
        description: `最近订单金额大幅低于均值（均值：$${Math.round(avgOrderValueUsd).toLocaleString()}）`,
        weight: RISK_WEIGHTS.DECLINING_VALUE,
      })
    }
  }

  return { score: Math.min(score, 100), factors }
}

// ─────────────────────────────────────────────────────────────
// evaluateFollowupStatus
// 纯函数：根据下次跟进时间判断状态
// ─────────────────────────────────────────────────────────────
export function evaluateFollowupStatus(
  nextFollowupAt: string | null,
  lastOrderDaysAgo: number | null
): FollowupStatus {
  // 超过365天无订单 → inactive
  if (lastOrderDaysAgo !== null && lastOrderDaysAgo > 365) {
    return 'inactive'
  }

  if (!nextFollowupAt) return 'normal'

  const daysUntilFollowup = (new Date(nextFollowupAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)

  if (daysUntilFollowup < -14) return 'at_risk'
  if (daysUntilFollowup < 0) return 'overdue'
  if (daysUntilFollowup <= 2) return 'due'
  return 'normal'
}

// ─────────────────────────────────────────────────────────────
// updateCustomerRhythm
// 同步单个客户的跟进状态（可单独调用，也可批量调用）
// ─────────────────────────────────────────────────────────────
export async function updateCustomerRhythm(
  supabase: SupabaseClient,
  customerName: string
): Promise<ServiceResult<CustomerRhythm>> {
  try {
    // 1. 读取该客户所有订单聚合数据
    const { data: orders, error: ordersErr } = await (supabase.from('orders') as any)
      .select('id, order_no, total_amount_usd, created_at, lifecycle_status, incoterm')
      .eq('customer_name', customerName)
      .order('created_at', { ascending: false })

    if (ordersErr) return err(`Failed to fetch orders: ${ordersErr.message}`)

    const allOrders = orders || []
    const activeOrders = allOrders.filter((o: any) =>
      !['completed', 'cancelled', '已完成', '已取消'].includes(o.lifecycle_status || '')
    )

    // 2. 计算聚合指标
    const totalOrderCount = allOrders.length
    const totalOrderValueUsd = allOrders.reduce(
      (sum: number, o: any) => sum + (Number(o.total_amount_usd) || 0), 0
    )
    const avgOrderValueUsd = totalOrderCount > 0 ? totalOrderValueUsd / totalOrderCount : 0

    const lastOrder = allOrders[0] // 已按 created_at DESC 排序
    const lastOrderAt = lastOrder?.created_at ?? null
    const lastOrderDaysAgo = lastOrderAt
      ? (Date.now() - new Date(lastOrderAt).getTime()) / (1000 * 60 * 60 * 24)
      : null
    const lastOrderValueUsd = lastOrder ? Number(lastOrder.total_amount_usd) || null : null

    // 3. 读取现有记录（获取 last_contact_at 等手动字段）
    const { data: existing } = await (supabase.from('customer_rhythm') as any)
      .select('*')
      .eq('customer_name', customerName)
      .maybeSingle()

    const lastContactAt = existing?.last_contact_at ?? null
    const lastContactDaysAgo = lastContactAt
      ? (Date.now() - new Date(lastContactAt).getTime()) / (1000 * 60 * 60 * 24)
      : null

    // 4. 计算客户等级
    const tier = calculateCustomerTier(totalOrderValueUsd, totalOrderCount, lastOrderDaysAgo)

    // 5. 计算下次跟进时间
    const followupIntervalDays = existing?.followup_interval_days
      ?? DEFAULT_FOLLOWUP_INTERVALS[tier]

    // 以最近联系日期或最近下单日期为基准
    const baseDate = lastContactAt ?? lastOrderAt ?? new Date().toISOString()
    const nextFollowupAt = new Date(
      new Date(baseDate).getTime() + followupIntervalDays * 24 * 60 * 60 * 1000
    ).toISOString()

    // 6. 评估跟进状态
    const followupStatus = evaluateFollowupStatus(
      existing?.next_followup_at ?? nextFollowupAt,
      lastOrderDaysAgo
    )

    // 7. 计算风险评分
    const { score: riskScore, factors: riskFactors } = calculateRiskScore({
      lastContactDaysAgo,
      lastOrderDaysAgo,
      followupStatus,
      orderCount: totalOrderCount,
      avgOrderValueUsd,
      lastOrderValueUsd,
    })

    // 8. Upsert customer_rhythm
    const payload = {
      customer_name: customerName,
      tier,
      next_followup_at: existing?.next_followup_at ?? nextFollowupAt,
      followup_interval_days: followupIntervalDays,
      followup_status: followupStatus,
      total_order_count: totalOrderCount,
      total_order_value_usd: totalOrderValueUsd,
      avg_order_value_usd: avgOrderValueUsd,
      last_order_at: lastOrderAt,
      active_order_count: activeOrders.length,
      risk_score: riskScore,
      risk_factors: riskFactors,
      updated_at: new Date().toISOString(),
    }

    const { data: rhythm, error: upsertErr } = await (supabase.from('customer_rhythm') as any)
      .upsert(payload, { onConflict: 'customer_name' })
      .select()
      .single()

    if (upsertErr) return err(`Failed to upsert customer_rhythm: ${upsertErr.message}`)

    // 9. 触发告警（at_risk + inactive 才告警，overdue 只产生 daily_task）
    if (followupStatus === 'at_risk') {
      await createSystemAlert(supabase, {
        alertType: 'customer_at_risk',
        severity: 'warning',
        entityType: 'customer',
        entityId: customerName,
        title: `⚠️ 客户流失风险：${customerName}`,
        description: `跟进逾期超14天，风险评分 ${riskScore}`,
        data: { customerName, riskScore, riskFactors, followupStatus },
        autoResolveHours: 168, // 7天
      })
    } else if (followupStatus === 'inactive') {
      await createSystemAlert(supabase, {
        alertType: 'customer_inactive',
        severity: 'warning',
        entityType: 'customer',
        entityId: customerName,
        title: `😴 客户已沉默：${customerName}`,
        description: `超365天无订单，请确认是否继续维护`,
        data: { customerName, lastOrderAt, lastOrderDaysAgo },
        autoResolveHours: 720, // 30天
      })
    } else {
      // 状态恢复正常 → 解除告警
      await resolveAlertByKey(supabase, 'customer_at_risk', customerName)
    }

    return ok(rhythm as CustomerRhythm)
  } catch (e: any) {
    return err(`updateCustomerRhythm exception: ${e?.message}`)
  }
}

// ─────────────────────────────────────────────────────────────
// syncAllCustomerRhythms
// Cron 调用：批量同步所有有过订单的客户
// ─────────────────────────────────────────────────────────────
export async function syncAllCustomerRhythms(
  supabase: SupabaseClient
): Promise<ServiceResult<CustomerRhythmSyncResult>> {
  try {
    // 获取所有不重复的客户名
    const { data: customerRows, error } = await (supabase.from('orders') as any)
      .select('customer_name')
      .neq('customer_name', null)
      .neq('customer_name', '')

    if (error) return err(`Failed to fetch customers: ${error.message}`)

    const customerNames = [...new Set(
      (customerRows || []).map((r: any) => r.customer_name as string).filter(Boolean)
    )]

    // 并发同步，最多 10 个并发（避免 Supabase 连接池压力）
    const BATCH_SIZE = 10
    let updated = 0
    let created = 0
    const errors: string[] = []

    for (let i = 0; i < customerNames.length; i += BATCH_SIZE) {
      const batch = customerNames.slice(i, i + BATCH_SIZE)

      const results = await Promise.allSettled(
        batch.map(name => updateCustomerRhythm(supabase, name))
      )

      for (let j = 0; j < results.length; j++) {
        const result = results[j]
        const name = batch[j]

        if (result.status === 'fulfilled' && result.value.ok) {
          updated++
        } else {
          const msg = result.status === 'rejected'
            ? result.reason?.message
            : !result.value.ok ? result.value.error : 'unknown'
          errors.push(`${name}: ${msg}`)
        }
      }
    }

    return ok({ updated, created, errors })
  } catch (e: any) {
    return err(`syncAllCustomerRhythms exception: ${e?.message}`)
  }
}

// ─────────────────────────────────────────────────────────────
// getCustomerRhythm
// 读取单个客户的跟进状态（用于客户详情页）
// ─────────────────────────────────────────────────────────────
export async function getCustomerRhythm(
  supabase: SupabaseClient,
  customerName: string
): Promise<ServiceResult<CustomerRhythm | null>> {
  const { data, error } = await (supabase.from('customer_rhythm') as any)
    .select('*')
    .eq('customer_name', customerName)
    .maybeSingle()

  if (error) return err(error.message)
  return ok(data as CustomerRhythm | null)
}

// ─────────────────────────────────────────────────────────────
// getCustomersNeedingFollowup
// Decision Engine：找出所有需要跟进的客户（按优先级排序）
// ─────────────────────────────────────────────────────────────
export async function getCustomersNeedingFollowup(
  supabase: SupabaseClient,
  options?: { tier?: 'A' | 'B' | 'C'; limit?: number }
): Promise<ServiceResult<CustomerRhythm[]>> {
  let query = (supabase.from('customer_rhythm') as any)
    .select('*')
    .in('followup_status', ['due', 'overdue', 'at_risk'])
    .neq('followup_status', 'inactive')
    .order('risk_score', { ascending: false })
    .order('next_followup_at', { ascending: true })

  if (options?.tier) {
    query = query.eq('tier', options.tier)
  }
  if (options?.limit) {
    query = query.limit(options.limit)
  }

  const { data, error } = await query
  if (error) return err(error.message)
  return ok(data as CustomerRhythm[])
}

// ─────────────────────────────────────────────────────────────
// recordCustomerContact
// 业务手动触发：记录联系时间，更新下次跟进日期
// ─────────────────────────────────────────────────────────────
export async function recordCustomerContact(
  supabase: SupabaseClient,
  customerName: string,
  contactedAt?: string
): Promise<ServiceResult<void>> {
  const now = contactedAt ?? new Date().toISOString()

  // 读取当前节奏设置
  const { data: existing } = await (supabase.from('customer_rhythm') as any)
    .select('followup_interval_days, tier')
    .eq('customer_name', customerName)
    .maybeSingle()

  const tier = existing?.tier ?? 'B'
  const intervalDays = existing?.followup_interval_days ?? DEFAULT_FOLLOWUP_INTERVALS[tier as CustomerTier]

  const nextFollowupAt = new Date(
    new Date(now).getTime() + intervalDays * 24 * 60 * 60 * 1000
  ).toISOString()

  const { error } = await (supabase.from('customer_rhythm') as any)
    .upsert({
      customer_name: customerName,
      last_contact_at: now,
      next_followup_at: nextFollowupAt,
      followup_status: 'normal',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'customer_name' })

  if (error) return err(error.message)

  // 联系后自动解除 at_risk 告警
  await resolveAlertByKey(supabase, 'customer_at_risk', customerName)

  return ok(undefined)
}
