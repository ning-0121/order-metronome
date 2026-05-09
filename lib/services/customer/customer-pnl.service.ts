// ============================================================
// Trade OS — Customer P&L Service
// 职责：计算单个客户的 P&L 汇总与行为画像
// 原则：
//   - 接受外部传入的 supabase client，可被 Server Action 和 materializer 复用
//   - 纯计算，不写数据库
//   - 结果由调用方决定是返回给前端还是写入 customer_rhythm
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export interface CustomerPnlData {
  customerName: string
  // ── 订单数量 ──
  totalOrders: number
  completedOrders: number
  activeOrders: number
  // ── 财务汇总 ──
  totalRevenueCny: number
  totalGrossProfitCny: number
  avgMarginPct: number
  bestMarginPct: number
  worstMarginPct: number
  marginTrend: 'up' | 'down' | 'flat' | 'unknown'
  // ── 付款行为 ──
  avgDepositDelayDays: number
  overduePayments: number
  // ── 交付表现 ──
  onTimeDeliveryRate: number | null
  avgDelayDays: number
  delayReasonBreakdown: Record<string, number>
  totalDelayRequests: number
  // ── 复盘信号 ──
  avgCustomerSatisfaction: number | null
  willRepeatRate: number | null
  // ── 行为画像标签 ──
  behaviorTags: string[]
}

const DONE_STATUSES = new Set(['completed', '已完成', '待复盘', '已复盘', 'archived', '已归档'])
const SNAP_PRIORITY = (t: string) => t === 'final' ? 3 : t === 'live' ? 2 : 1

export async function computeCustomerPnl(
  customerName: string,
  supabase: SupabaseClient,
): Promise<{ data?: CustomerPnlData; error?: string }> {
  // 1. 所有订单
  const { data: orders, error: ordersErr } = await (supabase.from('orders') as any)
    .select('id, lifecycle_status, created_at, factory_date, etd')
    .eq('customer_name', customerName)
    .order('created_at', { ascending: false })
    .limit(200)

  if (ordersErr) return { error: ordersErr.message }
  if (!orders || orders.length === 0) return { data: buildEmpty(customerName) }

  const orderIds: string[] = orders.map((o: any) => o.id)
  const totalOrders = orders.length
  const completedOrders = orders.filter((o: any) => DONE_STATUSES.has(o.lifecycle_status)).length
  const activeOrders = orders.filter(
    (o: any) => !DONE_STATUSES.has(o.lifecycle_status) && o.lifecycle_status !== 'cancelled' && o.lifecycle_status !== '已取消'
  ).length

  // 2. 批量拉取关联数据（4 张表，单次并发）
  const [
    { data: snapshots },
    { data: financials },
    { data: delays },
    { data: retros },
  ] = await Promise.all([
    (supabase.from('profit_snapshots') as any)
      .select('order_id, snapshot_type, gross_profit, gross_margin, revenue_cny, revenue_usd, exchange_rate')
      .in('order_id', orderIds),
    (supabase.from('order_financials') as any)
      .select('order_id, deposit_received_at, deposit_due_date, balance_received_at, overdue_days')
      .in('order_id', orderIds),
    (supabase.from('delay_requests') as any)
      .select('order_id, reason_category, delay_days, status')
      .in('order_id', orderIds)
      .eq('status', 'approved'),
    (supabase.from('order_retrospectives') as any)
      .select('order_id, on_time_delivery, customer_satisfaction, will_repeat_customer')
      .in('order_id', orderIds),
  ])

  // 3. 建立 order_id → 最优快照（final > live > forecast）
  const snapshotMap = new Map<string, any>()
  for (const s of snapshots || []) {
    const ex = snapshotMap.get(s.order_id)
    if (!ex || SNAP_PRIORITY(s.snapshot_type) > SNAP_PRIORITY(ex.snapshot_type)) {
      snapshotMap.set(s.order_id, s)
    }
  }

  const finMap = new Map<string, any>()
  for (const f of financials || []) finMap.set(f.order_id, f)

  const retroMap = new Map<string, any>()
  for (const r of retros || []) if (!retroMap.has(r.order_id)) retroMap.set(r.order_id, r)

  // ── 财务汇总 ──
  const margins: number[] = []
  let totalRevenueCny = 0
  let totalGrossProfitCny = 0

  for (const [, snap] of snapshotMap) {
    const revCny = snap.revenue_cny ?? (snap.revenue_usd ? snap.revenue_usd * (snap.exchange_rate ?? 7.2) : null)
    if (revCny != null) totalRevenueCny += revCny
    if (snap.gross_profit != null) totalGrossProfitCny += snap.gross_profit
    if (snap.gross_margin != null) margins.push(Number(snap.gross_margin) * 100)
  }

  const avgMarginPct = margins.length > 0 ? margins.reduce((a, b) => a + b, 0) / margins.length : 0
  const bestMarginPct = margins.length > 0 ? Math.max(...margins) : 0
  const worstMarginPct = margins.length > 0 ? Math.min(...margins) : 0

  // 趋势：最近 3 单
  let marginTrend: CustomerPnlData['marginTrend'] = 'unknown'
  const recentSnaps = orders.slice(0, 3).map((o: any) => snapshotMap.get(o.id)).filter(Boolean)
  if (recentSnaps.length >= 2) {
    const diff = Number(recentSnaps[0]?.gross_margin ?? 0) - Number(recentSnaps[recentSnaps.length - 1]?.gross_margin ?? 0)
    marginTrend = Math.abs(diff) < 0.01 ? 'flat' : diff > 0 ? 'up' : 'down'
  }

  // ── 付款行为 ──
  let totalDepositDelay = 0
  let depositCount = 0
  let overduePayments = 0

  for (const [, f] of finMap) {
    if (f.deposit_received_at && f.deposit_due_date) {
      const delay = Math.max(0, Math.floor(
        (new Date(f.deposit_received_at).getTime() - new Date(f.deposit_due_date).getTime()) / 86400000
      ))
      totalDepositDelay += delay
      depositCount++
    }
    if (f.overdue_days && f.overdue_days > 0) overduePayments++
  }

  const avgDepositDelayDays = depositCount > 0 ? Math.round(totalDepositDelay / depositCount) : 0

  // ── 延期分析 ──
  const delayReasonBreakdown: Record<string, number> = {}
  let totalDelayDays = 0
  let delayOrderCount = 0
  const delayedOrderIds = new Set<string>()

  for (const d of delays || []) {
    const cat = d.reason_category || 'other'
    delayReasonBreakdown[cat] = (delayReasonBreakdown[cat] ?? 0) + 1
    if (!delayedOrderIds.has(d.order_id)) {
      delayedOrderIds.add(d.order_id)
      delayOrderCount++
    }
    totalDelayDays += d.delay_days ?? 0
  }

  const avgDelayDays = delayOrderCount > 0 ? Math.round(totalDelayDays / delayOrderCount) : 0
  const totalDelayRequests = (delays || []).length

  // ── 交付表现（来自复盘）──
  const retroList = Array.from(retroMap.values())
  const withOnTime = retroList.filter((r: any) => r.on_time_delivery !== null)
  const onTimeDeliveryRate = withOnTime.length >= 2
    ? Math.round(withOnTime.filter((r: any) => r.on_time_delivery === true).length / withOnTime.length * 100)
    : null

  // ── 复盘信号 ──
  const withSatisfaction = retroList.filter((r: any) => r.customer_satisfaction != null)
  const avgCustomerSatisfaction = withSatisfaction.length > 0
    ? withSatisfaction.reduce((s: number, r: any) => s + r.customer_satisfaction, 0) / withSatisfaction.length
    : null

  const withRepeat = retroList.filter((r: any) => r.will_repeat_customer !== null)
  const willRepeatRate = withRepeat.length > 0
    ? Math.round(withRepeat.filter((r: any) => r.will_repeat_customer === true).length / withRepeat.length * 100)
    : null

  // ── 行为画像标签 ──
  const behaviorTags: string[] = []
  if (avgDepositDelayDays >= 7) behaviorTags.push('付款慢')
  if (avgDepositDelayDays === 0 && depositCount > 0) behaviorTags.push('付款准时')
  if (overduePayments >= 2) behaviorTags.push('多次逾期')
  if (totalDelayRequests >= 3) behaviorTags.push('延期频繁')
  if (onTimeDeliveryRate !== null && onTimeDeliveryRate >= 80 && withOnTime.length >= 2) behaviorTags.push('交期稳定')
  if (onTimeDeliveryRate !== null && onTimeDeliveryRate < 50 && withOnTime.length >= 2) behaviorTags.push('交期风险')
  if (avgMarginPct >= 20) behaviorTags.push('高利润客户')
  if (avgMarginPct > 0 && avgMarginPct < 10) behaviorTags.push('低利润')
  if (avgMarginPct <= 0 && margins.length > 0) behaviorTags.push('亏损风险')
  if (marginTrend === 'up' && margins.length >= 2) behaviorTags.push('利润提升')
  if (marginTrend === 'down' && margins.length >= 2) behaviorTags.push('利润下滑')
  if ((delayReasonBreakdown['customer'] ?? 0) >= 2) behaviorTags.push('客户原因多')
  if (willRepeatRate !== null && willRepeatRate >= 80) behaviorTags.push('合作稳健')
  if (totalOrders >= 5) behaviorTags.push('长期客户')

  return {
    data: {
      customerName,
      totalOrders,
      completedOrders,
      activeOrders,
      totalRevenueCny: Math.round(totalRevenueCny),
      totalGrossProfitCny: Math.round(totalGrossProfitCny),
      avgMarginPct: Math.round(avgMarginPct * 10) / 10,
      bestMarginPct: Math.round(bestMarginPct * 10) / 10,
      worstMarginPct: Math.round(worstMarginPct * 10) / 10,
      marginTrend,
      avgDepositDelayDays,
      overduePayments,
      onTimeDeliveryRate,
      avgDelayDays,
      delayReasonBreakdown,
      totalDelayRequests,
      avgCustomerSatisfaction: avgCustomerSatisfaction != null
        ? Math.round(avgCustomerSatisfaction * 10) / 10
        : null,
      willRepeatRate,
      behaviorTags,
    },
  }
}

function buildEmpty(customerName: string): CustomerPnlData {
  return {
    customerName, totalOrders: 0, completedOrders: 0, activeOrders: 0,
    totalRevenueCny: 0, totalGrossProfitCny: 0, avgMarginPct: 0,
    bestMarginPct: 0, worstMarginPct: 0, marginTrend: 'unknown',
    avgDepositDelayDays: 0, overduePayments: 0,
    onTimeDeliveryRate: null, avgDelayDays: 0, delayReasonBreakdown: {},
    totalDelayRequests: 0, avgCustomerSatisfaction: null, willRepeatRate: null,
    behaviorTags: [],
  }
}
