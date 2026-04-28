// ============================================================
// Order Decision Engine — Context Service
// 职责：组装决策引擎需要的全部上下文（9 个数据源）
// 原则：
//   1. 纯只读，不写任何表
//   2. 用 Promise.allSettled，单个查询失败不影响整体
//   3. 失败的数据源记录到 meta.completeness.missingFields
//   4. 不调 AI、不写规则、不出决策、不返回 UI
//   5. 订单本身查不到 → 直接 fail-fast 返回 NOT_FOUND
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { ok, err, type ServiceResult } from './types';
import type {
  OrderDecisionContext,
  ContextMeta,
  SimilarOrderSummary,
  FinalResult,
} from '@/lib/types/decision';

// ── 常量 ─────────────────────────────────────────────────────
const SIMILAR_ORDERS_LIMIT = 6; // 同客户近 6 单
const CUSTOMER_MEMORY_LIMIT = 20; // 客户事件最多取 20 条
const RECENT_DAYS = 90; // 近 90 天判定 recent_event_count

// ============================================================
// 公开 API
// ============================================================

export async function buildOrderDecisionContext(
  supabase: SupabaseClient,
  orderId: string,
  options: { lookbackOrders?: number } = {},
): Promise<ServiceResult<OrderDecisionContext>> {
  // ── 1. 必须先拿到订单本体（fail-fast）──────────────────────
  const orderRes = await (supabase.from('orders') as any)
    .select('*')
    .eq('id', orderId)
    .maybeSingle();

  if (orderRes.error) {
    return err(`查询订单失败：${orderRes.error.message}`, 'DB_ERROR');
  }
  if (!orderRes.data) {
    return err(`订单不存在：${orderId}`, 'NOT_FOUND');
  }

  const order = orderRes.data as Record<string, any>;
  const customerName = (order.customer_name ?? null) as string | null;
  const factoryId = (order.factory_id ?? null) as string | null;
  const lookbackLimit = options.lookbackOrders ?? SIMILAR_ORDERS_LIMIT;

  // ── 2. 并行加载其余 8 个数据源 ──────────────────────────────
  const [
    confirmationsR,
    financialsR,
    costBaselineR,
    procurementR,
    customerCoreR,
    customerMemoryR,
    factoryCoreR,
    rootCausesR,
    similarOrdersR,
  ] = await Promise.allSettled([
    (supabase.from('order_confirmations') as any)
      .select('*')
      .eq('order_id', orderId),
    (supabase.from('order_financials') as any)
      .select('*')
      .eq('order_id', orderId)
      .maybeSingle(),
    (supabase.from('order_cost_baseline') as any)
      .select('*')
      .eq('order_id', orderId)
      .maybeSingle(),
    (supabase.from('procurement_line_items') as any)
      .select('*')
      .eq('order_id', orderId),
    customerName
      ? (supabase.from('customers') as any)
          .select('*')
          .eq('name', customerName)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    customerName
      ? (supabase.from('customer_memory') as any)
          .select('id, category, content, created_at')
          .eq('customer_id', customerName)
          .order('created_at', { ascending: false })
          .limit(CUSTOMER_MEMORY_LIMIT)
      : Promise.resolve({ data: [], error: null }),
    factoryId
      ? (supabase.from('factories') as any)
          .select('*')
          .eq('id', factoryId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    (supabase.from('order_root_causes') as any)
      .select('*')
      .eq('order_id', orderId),
    customerName
      ? loadSimilarOrders(supabase, customerName, orderId, lookbackLimit)
      : Promise.resolve([] as SimilarOrderSummary[]),
  ]);

  // ── 3. 提取每个查询结果，失败的写入 missingFields ───────────
  const missingFields: string[] = [];

  const confirmations = extractList(confirmationsR, 'order_confirmations', missingFields);
  const financials = extractSingle(financialsR, 'order_financials', missingFields);
  const costBaseline = extractSingle(costBaselineR, 'order_cost_baseline', missingFields);
  const procurementItems = extractList(procurementR, 'procurement_line_items', missingFields);
  const customerCore = extractSingle(customerCoreR, 'customers', missingFields);
  const customerMemoryList = extractList(customerMemoryR, 'customer_memory', missingFields);
  const factoryCore = extractSingle(factoryCoreR, 'factories', missingFields);
  const rootCauses = extractList(rootCausesR, 'order_root_causes', missingFields);

  let similarOrders: SimilarOrderSummary[] = [];
  if (similarOrdersR.status === 'fulfilled') {
    similarOrders = similarOrdersR.value as SimilarOrderSummary[];
  } else {
    missingFields.push('similar_orders');
  }

  // ── 4. 派生 customerProfile（合并 customers + customer_memory 聚合）─
  const customerProfile = customerName
    ? buildCustomerProfile(customerName, customerCore, customerMemoryList)
    : null;

  // ── 5. factoryProfile：Phase 1.0 直接透传 factories 行
  //      （Phase 2 才会建 factory_capability_profile 表，那时这里再合并）
  const factoryProfile = factoryCore;

  // ── 6. 元数据：完整度自检 ──────────────────────────────────
  const meta: ContextMeta = {
    fetchedAt: new Date().toISOString(),
    completeness: {
      hasFinancials: financials !== null,
      hasCostBaseline: costBaseline !== null,
      hasCustomerProfile: customerProfile !== null,
      hasFactoryProfile: factoryProfile !== null,
      hasConfirmations: confirmations.length > 0,
      hasProcurementItems: procurementItems.length > 0,
      missingFields,
    },
  };

  return ok({
    order,
    confirmations,
    financials,
    costBaseline,
    procurementItems,
    customerProfile,
    factoryProfile,
    rootCauses,
    similarOrders,
    meta,
  });
}

// ============================================================
// 私有 helpers
// ============================================================

/** 从 Promise.allSettled 结果里提取单条记录 */
function extractSingle(
  result: PromiseSettledResult<{ data: any; error: any }>,
  fieldName: string,
  missing: string[],
): Record<string, any> | null {
  if (result.status === 'rejected') {
    missing.push(fieldName);
    return null;
  }
  if (result.value.error) {
    missing.push(`${fieldName}:${result.value.error.code || 'query_error'}`);
    return null;
  }
  return (result.value.data ?? null) as Record<string, any> | null;
}

/** 从 Promise.allSettled 结果里提取列表 */
function extractList(
  result: PromiseSettledResult<{ data: any; error: any }>,
  fieldName: string,
  missing: string[],
): Record<string, any>[] {
  if (result.status === 'rejected') {
    missing.push(fieldName);
    return [];
  }
  if (result.value.error) {
    missing.push(`${fieldName}:${result.value.error.code || 'query_error'}`);
    return [];
  }
  return (result.value.data ?? []) as Record<string, any>[];
}

/**
 * 把 customers 主档 + customer_memory 事件聚合成一个客户画像快照
 *
 * Phase 1.0：仅基础聚合（投诉数 / 质量问题数 / 近期活动数）
 * Phase 2：建立 customer_behavior_profile 表后扩展（确认速度 / 付款速度 / 改单频率 / 压价幅度）
 */
function buildCustomerProfile(
  customerName: string,
  customerCore: Record<string, any> | null,
  memoryEvents: Record<string, any>[],
): Record<string, any> {
  const cutoffMs = Date.now() - RECENT_DAYS * 86400_000;

  const complaintCount = memoryEvents.filter(m => m.category === 'complaint').length;
  const qualityIssueCount = memoryEvents.filter(m => m.category === 'quality').length;
  const recentEventCount = memoryEvents.filter(m => {
    const t = m.created_at ? new Date(m.created_at).getTime() : 0;
    return t > cutoffMs;
  }).length;

  return {
    customer_name: customerName,
    customer_core: customerCore, // 含 is_new_customer / payment_terms 等基础字段
    complaint_count_total: complaintCount,
    quality_issue_count_total: qualityIssueCount,
    recent_90d_event_count: recentEventCount,
    memory_events_recent: memoryEvents.slice(0, 10),
    // 未来 Phase 2 的扩展位（暂留 null，规则按 hasEnoughData 跳过）：
    avg_confirmation_hours: null,
    payment_delay_days_avg: null,
    amendment_count_per_order: null,
    repurchase_rate: null,
  };
}

/**
 * 加载同客户近 N 单 + 复盘数据
 *
 * 内部双 try/catch：order_outcome_reviews 加载失败不影响 orders 列表
 */
async function loadSimilarOrders(
  supabase: SupabaseClient,
  customerName: string,
  excludeOrderId: string,
  limit: number,
): Promise<SimilarOrderSummary[]> {
  try {
    const { data: orders, error } = await (supabase.from('orders') as any)
      .select('id, order_no, customer_name, lifecycle_status, created_at')
      .eq('customer_name', customerName)
      .neq('id', excludeOrderId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error || !orders || orders.length === 0) return [];

    const orderIds = (orders as any[]).map(o => o.id);

    // 复盘表查询失败不阻塞 — 返回 outcomeMap 为空即可
    let outcomes: any[] = [];
    try {
      const { data } = await (supabase.from('order_outcome_reviews') as any)
        .select('order_id, final_result, delay_days, actual_margin_pct')
        .in('order_id', orderIds);
      outcomes = (data || []) as any[];
    } catch {
      // 静默：outcome 缺失只是 similar orders 没有结果数据，不致命
    }

    const outcomeMap = new Map<string, any>();
    for (const o of outcomes) outcomeMap.set(o.order_id, o);

    return (orders as any[]).map(o => {
      const oc = outcomeMap.get(o.id);
      return {
        orderNo: (o.order_no ?? '') as string,
        customerName: (o.customer_name ?? null) as string | null,
        delayDays: (oc?.delay_days ?? null) as number | null,
        actualMarginPct: (oc?.actual_margin_pct ?? null) as number | null,
        finalResult: (oc?.final_result ?? null) as FinalResult | null,
      };
    });
  } catch {
    return [];
  }
}
