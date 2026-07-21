// ============================================================
// Trade OS — Profit Snapshot Service
// 职责：从 order_financials + order_cost_baseline 计算利润快照
//       写入 profit_snapshots，触发告警
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { ok, err, type ServiceResult } from './types'
import type {
  ProfitInput,
  ProfitCalculationResult,
  ProfitSnapshot,
  MarginStatus,
  SnapshotType,
} from './types'
import { TERMINAL_LIFECYCLE_FILTER } from '@/lib/domain/lifecycleStatus'
import { createSystemAlert, resolveAlertByKey, MARGIN_THRESHOLDS } from './alerts.service'
import { deriveOrderQuantityContext, quantityForBasis } from '@/lib/domain/quantity-engine'

// ── 利润状态判断（纯函数，可单独测试）───────────────────────
export function evaluateMarginStatus(margin: number | null): MarginStatus {
  if (margin === null || margin === undefined) return 'unset'
  if (margin < 0) return 'negative'
  if (margin < MARGIN_THRESHOLDS.WARNING) return 'critical'
  if (margin < MARGIN_THRESHOLDS.HEALTHY) return 'warning'
  return 'healthy'
}

// ── 数据完整度评分（纯函数）─────────────────────────────────
interface CompletenessResult {
  score: number       // 0-100
  missing: string[]
}

export function checkDataCompleteness(financials: any, baseline: any, order: any): CompletenessResult {
  const missing: string[] = []
  let totalFields = 0
  let presentFields = 0

  function check(condition: boolean, fieldName: string) {
    totalFields++
    if (condition) presentFields++
    else missing.push(fieldName)
  }

  // 收入数据（权重高）
  check(!!financials?.sale_total || !!financials?.sale_price_per_piece, '销售总额/单价')
  check(!!financials?.exchange_rate, '汇率')

  // 成本数据
  check(!!baseline?.budget_fabric_amount || !!financials?.cost_material, '面料成本')
  check(!!baseline?.cmt_factory_quote || !!financials?.cost_cmt, '加工费')
  check(financials?.cost_shipping != null, '运费')  // 审计 P1:原 !!x!==undefined 恒真,运费永远算"已填"

  // 订单基础数据
  check(!!order?.quantity, '订单数量')
  check(!!order?.incoterm, '贸易条款')

  const score = Math.round((presentFields / totalFields) * 100)
  return { score, missing }
}

// ── 从现有数据源聚合利润数字 ──────────────────────────────────
function aggregateProfitNumbers(financials: any, baseline: any, order: any, overrides?: ProfitInput['overrides']) {
  const exchangeRate = overrides?.exchangeRate ?? financials?.exchange_rate ?? 7.2
  const qtyCtx = deriveOrderQuantityContext({
    physicalQuantity: order?.quantity ?? null,
    quantityUnit: order?.quantity_unit ?? null,
  })
  const quantity = quantityForBasis(qtyCtx, 'PER_SET') ?? order?.quantity ?? 0

  // 收入（优先用 sale_total，没有则用单价×数量）
  let revenueCny: number | null = null
  let revenueUsd: number | null = null

  if (overrides?.revenueCny) {
    revenueCny = overrides.revenueCny
  } else if (financials?.sale_total) {
    const currency = financials.sale_currency || 'USD'
    if (currency === 'CNY' || currency === 'RMB') {
      revenueCny = Number(financials.sale_total)
    } else {
      revenueUsd = Number(financials.sale_total)
      revenueCny = revenueUsd * exchangeRate
    }
  } else if (financials?.sale_price_per_piece && quantity > 0) {
    const currency = financials.sale_currency || 'USD'
    const totalUsd = Number(financials.sale_price_per_piece) * quantity
    if (currency === 'CNY') {
      revenueCny = totalUsd
    } else {
      revenueUsd = totalUsd
      revenueCny = totalUsd * exchangeRate
    }
  }

  if (overrides?.revenueUsd) revenueUsd = overrides.revenueUsd

  // 成本（优先用 overrides，其次 order_financials，最后 cost_baseline）
  // 审计 P1:原用 `||` → 合法 0 值(cost_material=0)被当缺失回退到预算面料额。
  // 改显式 null 判断:financials 填了(含 0)就用它,没填才回退基线。
  // 料款优先级(2026-07-20 冲90资金流):手动override > 采购实付(录入率≥0.8) > order_financials预算 > 基线。
  //   实付录入率 cost_actual_coverage<0.8 视为数据不全 → 回退预算,不因实付未录全把成本算低/利润算高。
  //   (阈值同 order-financials.COST_ACTUAL_COVERAGE_THRESHOLD;此处 lib 不 import server action,硬编码 0.8。)
  const useActualMaterial = financials?.cost_material_actual != null
    && Number(financials?.cost_material_actual) > 0
    && Number(financials?.cost_actual_coverage ?? 0) >= 0.8
  const materialCost = overrides?.materialCost
    ?? (useActualMaterial
      ? Number(financials.cost_material_actual)
      : (financials?.cost_material != null
        ? Number(financials.cost_material)
        : Number(baseline?.budget_fabric_amount ?? 0)))

  const processingCost = overrides?.processingCost
    ?? (financials?.cost_cmt != null
      ? Number(financials.cost_cmt)
      : Number(baseline?.cmt_factory_quote ?? 0) * quantity)

  const logisticsCost = overrides?.logisticsCost ?? Number(financials?.cost_shipping ?? 0)
  const otherCost = overrides?.otherCost ?? Number(financials?.cost_other ?? 0)

  const totalCost = materialCost + processingCost + logisticsCost + otherCost

  // 利润计算
  const grossProfit = revenueCny !== null ? revenueCny - totalCost : null
  const grossMargin = revenueCny && revenueCny > 0 && grossProfit !== null
    ? grossProfit / revenueCny
    : null

  return {
    revenueUsd,
    revenueCny,
    exchangeRate,
    materialCost,
    processingCost,
    logisticsCost,
    otherCost,
    totalCost,
    grossProfit,
    grossMargin,
  }
}

// ─────────────────────────────────────────────────────────────
// calculateProfitSnapshot
// 主函数：计算 + 写入 DB + 触发告警
// ─────────────────────────────────────────────────────────────
export async function calculateProfitSnapshot(
  supabase: SupabaseClient,
  input: ProfitInput
): Promise<ServiceResult<ProfitCalculationResult>> {
  try {
    const { orderId, snapshotType, overrides } = input

    // 1. 读取订单基础数据
    const { data: order, error: orderErr } = await (supabase.from('orders') as any)
      .select('id, order_no, customer_name, quantity, quantity_unit, incoterm, order_type')
      .eq('id', orderId)
      .single()

    if (orderErr || !order) {
      return err(`Order not found: ${orderId}`)
    }

    // 2. 读取财务数据（并行）
    const [financialsRes, baselineRes] = await Promise.allSettled([
      (supabase.from('order_financials') as any)
        .select('*').eq('order_id', orderId).maybeSingle(),
      (supabase.from('order_cost_baseline') as any)
        .select('*').eq('order_id', orderId).maybeSingle(),
    ])

    const financials = financialsRes.status === 'fulfilled' ? financialsRes.value.data : null
    const baseline = baselineRes.status === 'fulfilled' ? baselineRes.value.data : null

    // 3. 聚合利润数字
    const numbers = aggregateProfitNumbers(financials, baseline, order, overrides)

    // 4. 评估数据质量
    const { score: dataCompleteness, missing: missingFields } =
      checkDataCompleteness(financials, baseline, order)

    // 5. 判断利润状态
    const marginStatus = evaluateMarginStatus(numbers.grossMargin)

    // 6. 写入 profit_snapshots（upsert by order_id + snapshot_type）
    const snapshotPayload = {
      order_id: orderId,
      snapshot_type: snapshotType,
      revenue_usd: numbers.revenueUsd,
      revenue_cny: numbers.revenueCny,
      exchange_rate: numbers.exchangeRate,
      material_cost: numbers.materialCost,
      processing_cost: numbers.processingCost,
      logistics_cost: numbers.logisticsCost,
      other_cost: numbers.otherCost,
      total_cost: numbers.totalCost,
      gross_profit: numbers.grossProfit,
      gross_margin: numbers.grossMargin,
      margin_status: marginStatus,
      data_completeness: dataCompleteness,
      missing_fields: missingFields,
      updated_at: new Date().toISOString(),
    }

    const { data: snapshot, error: snapErr } = await (supabase.from('profit_snapshots') as any)
      .upsert(snapshotPayload, { onConflict: 'order_id,snapshot_type' })
      .select()
      .single()

    if (snapErr) {
      return err(`Failed to save profit snapshot: ${snapErr.message}`)
    }

    // 收口利润双轨(2026-07-21):profit_snapshots 为利润单一真相源;顺手把 order_financials.margin_pct/
    //   gross_profit_rmb 同步成快照值,避免建单期旧值与快照发散(orderDecisionRules/riskAssessment 等读 margin_pct)。
    //   仅 live 快照同步;best-effort,失败不阻断。
    if (snapshotType === 'live') {
      try {
        await (supabase.from('order_financials') as any).update({
          margin_pct: numbers.grossMargin != null ? Number((numbers.grossMargin * 100).toFixed(1)) : null,
          gross_profit_rmb: numbers.grossProfit != null ? Number(numbers.grossProfit.toFixed(2)) : null,
          updated_at: new Date().toISOString(),
        }).eq('order_id', orderId)
      } catch { /* 同步失败不阻断快照 */ }
    }

    // 7. 触发告警逻辑
    let shouldAlert = false
    let alertSeverity = null as any

    if (marginStatus === 'negative' || marginStatus === 'critical') {
      shouldAlert = true
      alertSeverity = marginStatus === 'negative' ? 'critical' : 'warning'

      const alertType = marginStatus === 'negative' ? 'negative_margin' : 'low_margin'
      const marginPct = numbers.grossMargin !== null
        ? `${(numbers.grossMargin * 100).toFixed(1)}%`
        : '未知'

      await createSystemAlert(supabase, {
        alertType,
        severity: alertSeverity,
        entityType: 'order',
        entityId: orderId,
        title: marginStatus === 'negative'
          ? `⚠️ 亏损订单：${order.order_no}`
          : `⚠️ 利润偏低：${order.order_no}`,
        description: `毛利率 ${marginPct}（客户：${order.customer_name}）`,
        data: {
          orderId,
          orderNo: order.order_no,
          customerName: order.customer_name,
          grossMargin: numbers.grossMargin,
          grossProfit: numbers.grossProfit,
          revenueCny: numbers.revenueCny,
          totalCost: numbers.totalCost,
        },
        autoResolveHours: 72,
      })
    } else if (marginStatus === 'healthy' || marginStatus === 'warning') {
      // 利润恢复正常 → 自动解决之前的告警
      await resolveAlertByKey(supabase, 'negative_margin', orderId)
      if (marginStatus === 'healthy') {
        await resolveAlertByKey(supabase, 'low_margin', orderId)
      }
    }

    return ok({
      snapshot: snapshot as ProfitSnapshot,
      marginStatus,
      shouldAlert,
      alertSeverity,
      dataCompleteness,
      missingFields,
    })
  } catch (e: any) {
    return err(`calculateProfitSnapshot exception: ${e?.message}`)
  }
}

// ─────────────────────────────────────────────────────────────
// getProfitSnapshot
// 读取最新快照（用于展示）
// ─────────────────────────────────────────────────────────────
export async function getProfitSnapshot(
  supabase: SupabaseClient,
  orderId: string,
  snapshotType: SnapshotType = 'live'
): Promise<ServiceResult<ProfitSnapshot | null>> {
  const { data, error } = await (supabase.from('profit_snapshots') as any)
    .select('*')
    .eq('order_id', orderId)
    .eq('snapshot_type', snapshotType)
    .maybeSingle()

  if (error) return err(error.message)
  return ok(data as ProfitSnapshot | null)
}

// ─────────────────────────────────────────────────────────────
// getOrdersWithLowMargin
// 决策引擎用：找出所有利润偏低的进行中订单
// ─────────────────────────────────────────────────────────────
export async function getOrdersWithLowMargin(
  supabase: SupabaseClient,
  threshold: number = MARGIN_THRESHOLDS.WARNING
): Promise<ServiceResult<Array<ProfitSnapshot & { order_no: string; customer_name: string }>>> {
  const { data, error } = await (supabase.from('profit_snapshots') as any)
    .select(`
      *,
      orders!inner(order_no, customer_name, lifecycle_status)
    `)
    .eq('snapshot_type', 'live')
    .in('margin_status', ['critical', 'negative', 'warning'])
    .not('orders.lifecycle_status', 'in', TERMINAL_LIFECYCLE_FILTER)
    .order('gross_margin', { ascending: true })

  if (error) return err(error.message)

  const result = (data || []).map((row: any) => ({
    ...row,
    order_no: row.orders?.order_no,
    customer_name: row.orders?.customer_name,
  }))

  return ok(result)
}
