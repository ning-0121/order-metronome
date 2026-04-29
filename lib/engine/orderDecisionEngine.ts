// ============================================================
// Order Decision Engine — Orchestrator Layer
// 职责：编排 context → rules → 持久化 → 返回 DecisionResult
//
// 严格纪律（用户 2026-04-28 确认）：
//   1. 不调 AI（仅保留接口位置）
//   2. 不写任何业务表（orders / milestones / financials 等）
//   3. 只允许写 order_decision_reviews
//   4. 任何异常都必须兜底返回 DecisionResult，不允许 throw 中断
//   5. 24h 同 input_hash 缓存命中直接返回
//   6. 单订单 24h 内 ≥3 次评审 → 拒绝写新记录，返回 daily limit reached
//   7. workflowControls / rhythmAdjustment 仅生成不执行（Phase 1.0 不真阻塞）
// ============================================================

import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  OrderDecisionContext,
  RuleFlag,
  RulesPrediction,
  DecisionResult,
  DecisionValue,
  RecommendedAction,
  RunDecisionOptions,
  WorkflowControls,
  RhythmAdjustment,
  AuditSummary,
  AuditCategory,
  RuleFlagId,
  Severity,
} from '@/lib/types/decision';
import { buildOrderDecisionContext } from '@/lib/services/order-decision-context.service';
import { evaluateOrderDecisionRules } from './orderDecisionRules';

// ────────────────────────────────────────────────────────────
// 常量
// ────────────────────────────────────────────────────────────

const CACHE_WINDOW_HOURS = 24;
const RATE_LIMIT_PER_DAY = 3;

/**
 * 致命规则 — 触发任一即升级到 STOP
 *
 * 用户 2026-04-28 明确：决策聚合策略
 *   - 任一致命规则触发 → STOP
 *   - 否则有任何 flag → CAUTION
 *   - 0 flag → PROCEED
 *
 * 注：Rule 6 子规则 ≤7d 时 individual decision='STOP'，但因不在致命列表，
 *      在引擎层会被聚合为 CAUTION（仍展示原始 STOP 标签和 blockedMilestone）
 */
const FATAL_RULE_IDS: RuleFlagId[] = [
  'three_doc_price_mismatch',
  'margin_below_5pct',
  'deposit_not_received_pre_production',
  'balance_not_received_pre_shipment',
  'new_customer_complex_no_deposit',
];

// 决策路径固定 confidence 值（Phase 1.0 仅规则）
const CONFIDENCE_PROCEED = 80;
const CONFIDENCE_CAUTION = 60;
const CONFIDENCE_STOP = 40;

// 兜底场景（fallback / rate limit）confidence
const CONFIDENCE_FALLBACK = 30;

// 节拍调整（rhythmAdjustment.addBufferDays）
const BUFFER_DAYS_STOP = 7;
const BUFFER_DAYS_CAUTION = 3;

// ============================================================
// 公开 API
// ============================================================

export async function runOrderDecisionReview(
  supabase: SupabaseClient,
  orderId: string,
  options: RunDecisionOptions = { triggeredBy: 'manual' },
): Promise<DecisionResult> {
  try {
    // 1. 加载 context（Promise.allSettled 已在 service 层处理，此处仅取结果）
    const ctxRes = await buildOrderDecisionContext(supabase, orderId);
    if (!ctxRes.ok) {
      return buildSafeFallback(`decision engine fallback: 加载上下文失败 - ${ctxRes.error}`);
    }
    const ctx = ctxRes.data;

    // 2. 计算 input_hash（用于缓存命中）
    const inputHash = computeInputHash(ctx);

    // 3. 缓存命中检查（24h 同 hash 直接返回）
    if (!options.forceFresh) {
      const cached = await loadCachedReview(supabase, orderId, inputHash);
      if (cached) return cached;
    }

    // 4. 限流检查（24h 内 ≥3 次评审 → 拒写）
    const reviewCount = await countRecentReviews(supabase, orderId);
    if (reviewCount >= RATE_LIMIT_PER_DAY) {
      return buildSafeFallback('daily limit reached');
    }

    // 5. 跑规则（11 条）
    const prediction = evaluateOrderDecisionRules(ctx);

    // ──────────────────────────────────────────────────────────
    // 6. AI 调用接口位置（Phase 1.0 永远不调用，仅作占位）
    //
    //    Phase 1.1+ 启用时取消此处注释：
    //    let aiVerdict: AiVerdict | null = null;
    //    if (prediction.whetherAiNeeded) {
    //      const aiRes = await runOrderDecisionAi(ctx, prediction, { riskLevel: ..., cacheKey: inputHash });
    //      if (aiRes.ok) aiVerdict = aiRes.verdict;
    //      else aiVerdict = aiRes.fallback;
    //    }
    //
    //    Phase 1.0 严格纪律：whetherAiNeeded 永远 false（rules 层强制），所以即使
    //    将来某个 bug 让 whetherAiNeeded 误为 true，这里也不会调 AI（接口未连）。
    // ──────────────────────────────────────────────────────────

    // 7. 合成最终 DecisionResult
    const decisionResult = composeDecisionResult(prediction);

    // 8. 持久化到 order_decision_reviews（失败不影响返回值）
    await persistReview(supabase, orderId, inputHash, decisionResult, prediction.flags, options);

    return decisionResult;
  } catch (err: any) {
    // 任何意外异常都必须兜底返回，不能让 caller 看到 throw
    console.error('[orderDecisionEngine] unexpected error:', err?.message ?? err);
    return buildSafeFallback(
      `decision engine fallback: ${err?.message || 'unknown error'}`,
    );
  }
}

// ============================================================
// input_hash 计算
// ============================================================

/**
 * 提取 context 中影响决策的关键字段，生成稳定 hash
 *
 * 缓存命中规则：只要这些字段不变，决策结果应当一致
 *   - 订单基本属性（quantity / factory_id / factory_date / etd / incoterm / unit_price）
 *   - 客户/工厂标记（is_new_customer / is_new_factory / special_tags）
 *   - 财务字段（margin / deposit / balance / sale_price）
 *   - 成本基线（fob / ddp）
 *   - 确认链状态（fabric_color / size_breakdown / logo_print / packaging_label）
 *   - 采购明细数量（影响 Rule 4 准备生产信号）
 */
function computeInputHash(ctx: OrderDecisionContext): string {
  const o = ctx.order;
  const f = ctx.financials;
  const cb = ctx.costBaseline;

  const stableInput = {
    orderId: o.id,
    quantity: o.quantity ?? null,
    factoryId: o.factory_id ?? null,
    factoryDate: o.factory_date ?? null,
    etd: o.etd ?? null,
    incoterm: o.incoterm ?? null,
    unitPrice: o.unit_price ?? null,
    isNewCustomer: o.is_new_customer ?? null,
    isNewFactory: o.is_new_factory ?? null,
    specialTags: Array.isArray(o.special_tags)
      ? [...o.special_tags].sort()
      : [],
    lifecycleStatus: o.lifecycle_status ?? null,

    margin: f?.margin_pct ?? null,
    salePrice: f?.sale_price_per_piece ?? null,
    saleTotal: f?.sale_total ?? null,
    depositAmount: f?.deposit_amount ?? null,
    depositStatus: f?.deposit_status ?? null,
    balanceAmount: f?.balance_amount ?? null,
    balanceStatus: f?.balance_status ?? null,

    fobPrice: cb?.fob_price ?? null,
    ddpPrice: cb?.ddp_price ?? null,

    confirmations: ctx.confirmations
      .map(c => `${c.module}:${c.status}`)
      .sort(),

    procurementItemCount: ctx.procurementItems.length,
  };

  const json = JSON.stringify(stableInput);
  return createHash('sha256').update(json).digest('hex').slice(0, 32);
}

// ============================================================
// DB 读：缓存命中 + 限流
// ============================================================

async function loadCachedReview(
  supabase: SupabaseClient,
  orderId: string,
  inputHash: string,
): Promise<DecisionResult | null> {
  try {
    const cutoff = new Date(
      Date.now() - CACHE_WINDOW_HOURS * 3600_000,
    ).toISOString();
    const { data, error } = await (supabase.from('order_decision_reviews') as any)
      .select('result_json')
      .eq('order_id', orderId)
      .eq('input_hash', inputHash)
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data?.result_json) return null;
    return data.result_json as DecisionResult;
  } catch (err: any) {
    console.error('[orderDecisionEngine] cache lookup failed:', err?.message);
    return null;
  }
}

async function countRecentReviews(
  supabase: SupabaseClient,
  orderId: string,
): Promise<number> {
  try {
    const cutoff = new Date(
      Date.now() - CACHE_WINDOW_HOURS * 3600_000,
    ).toISOString();
    const { count, error } = await (supabase.from('order_decision_reviews') as any)
      .select('*', { count: 'exact', head: true })
      .eq('order_id', orderId)
      .gte('created_at', cutoff);
    if (error) return 0;
    return count ?? 0;
  } catch {
    return 0;
  }
}

// ============================================================
// 决策合成
// ============================================================

function aggregateDecision(flags: RuleFlag[]): DecisionValue {
  if (flags.some(f => FATAL_RULE_IDS.includes(f.id))) return 'STOP';
  if (flags.length > 0) return 'CAUTION';
  return 'PROCEED';
}

function severityRank(s: Severity): number {
  return s === 'high' ? 3 : s === 'medium' ? 2 : 1;
}

function buildAuditSummary(
  flags: RuleFlag[],
  category: AuditCategory,
): AuditSummary {
  const categoryFlags = flags.filter(f => f.category === category);
  if (categoryFlags.length === 0) {
    return { flags: [], summary: '通过' };
  }
  const stopCount = categoryFlags.filter(f => f.decision === 'STOP').length;
  const cautionCount = categoryFlags.filter(f => f.decision === 'CAUTION').length;
  const summary =
    stopCount > 0
      ? `${stopCount} 项严重${cautionCount > 0 ? ` + ${cautionCount} 项注意` : ''}`
      : `${cautionCount} 项注意`;
  return { flags: categoryFlags, summary };
}

function buildWorkflowControls(
  decision: DecisionValue,
  flags: RuleFlag[],
): WorkflowControls {
  const blocked = new Set(
    flags.map(f => f.blockedMilestone).filter(Boolean) as string[],
  );
  const isStop = decision === 'STOP';
  const hasFactoryRisk = flags.some(f => f.id === 'factory_capacity_risk');

  return {
    blockProcurement:
      isStop &&
      (blocked.has('procurement_order_placed') || blocked.has('production_kickoff')),
    blockProduction:
      isStop &&
      (blocked.has('production_kickoff') || blocked.has('production_order_upload')),
    blockShipment:
      isStop &&
      (blocked.has('shipment_execute') || blocked.has('booking_done')),
    requireApprovalNodes: Array.from(blocked).sort(),
    addedRiskMilestones: hasFactoryRisk
      ? ['mid_qc_check', 'final_qc_check']
      : [],
    increaseReminderFrequency: decision !== 'PROCEED',
  };
}

function buildRhythmAdjustment(
  decision: DecisionValue,
  flags: RuleFlag[],
): RhythmAdjustment {
  const addBufferDays =
    decision === 'STOP'
      ? BUFFER_DAYS_STOP
      : decision === 'CAUTION'
        ? BUFFER_DAYS_CAUTION
        : 0;
  const hasFactoryRisk = flags.some(f => f.id === 'factory_capacity_risk');
  const hasFeasibilityFlags = flags.some(f => f.category === 'feasibility');

  return {
    addBufferDays,
    addExtraQc: hasFeasibilityFlags,
    requireBackupFactory: hasFactoryRisk,
  };
}

function buildExplanation(
  decision: DecisionValue,
  flags: RuleFlag[],
): string {
  if (flags.length === 0) {
    return '11 条核心规则全部通过，订单可按正常节奏推进。';
  }
  const lines: string[] = [];
  lines.push(`决策：${decision}（基于 ${flags.length} 项规则触发）`);
  for (const f of flags.slice(0, 5)) {
    lines.push(`• [${f.category}] ${f.message}`);
  }
  if (flags.length > 5) {
    lines.push(`• ……另有 ${flags.length - 5} 项见详细评审记录`);
  }
  return lines.join('\n');
}

function inferTargetRole(category: AuditCategory): string {
  if (category === 'financial') return 'finance';
  if (category === 'feasibility') return 'merchandiser';
  return 'sales';
}

function composeDecisionResult(prediction: RulesPrediction): DecisionResult {
  const decision = aggregateDecision(prediction.flags);
  const confidence =
    decision === 'PROCEED'
      ? CONFIDENCE_PROCEED
      : decision === 'CAUTION'
        ? CONFIDENCE_CAUTION
        : CONFIDENCE_STOP;

  const businessAudit = buildAuditSummary(prediction.flags, 'business');
  const financialAudit = buildAuditSummary(prediction.flags, 'financial');
  const feasibilityAudit = buildAuditSummary(prediction.flags, 'feasibility');

  // requiredActions：按严重度排序，最多取 3 条
  const sortedFlags = [...prediction.flags].sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity),
  );
  const requiredActions: RecommendedAction[] = [];
  for (const f of sortedFlags) {
    if (!f.nextAction) continue;
    requiredActions.push({
      action: f.nextAction,
      targetRole: inferTargetRole(f.category),
      urgency: f.severity === 'high' ? 'now' : 'within_24h',
    });
    if (requiredActions.length >= 3) break;
  }

  return {
    decision,
    confidence,
    source: 'rules',
    businessAudit,
    financialAudit,
    feasibilityAudit,
    requiredActions,
    workflowControls: buildWorkflowControls(decision, prediction.flags),
    rhythmAdjustment: buildRhythmAdjustment(decision, prediction.flags),
    explanation: buildExplanation(decision, prediction.flags),
    aiUsed: false,
    costUsd: null,
  };
}

// ============================================================
// 持久化
// ============================================================

async function persistReview(
  supabase: SupabaseClient,
  orderId: string,
  inputHash: string,
  result: DecisionResult,
  ruleFlags: RuleFlag[],
  options: RunDecisionOptions,
): Promise<void> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    const createdBy = user?.id ?? null;

    await (supabase.from('order_decision_reviews') as any).insert({
      order_id: orderId,
      review_type: options.reviewType ?? 'manual',
      input_hash: inputHash,
      triggered_by: options.triggeredBy,
      triggered_field: options.triggeredField ?? null,
      decision: result.decision,
      confidence: result.confidence,
      business_audit: result.businessAudit,
      financial_audit: result.financialAudit,
      feasibility_audit: result.feasibilityAudit,
      result_json: result,
      rule_flags: ruleFlags,
      ai_used: false,
      ai_call_count: 0,
      created_by: createdBy,
    });
  } catch (err: any) {
    // 持久化失败不影响主流程：caller 仍能拿到 result，只是没历史记录
    console.error('[orderDecisionEngine] persist failed:', err?.message ?? err);
  }
}

// ============================================================
// Fallback DecisionResult
// ============================================================

/**
 * 兜底结果：任何异常 / 限流 / context 加载失败时返回
 *
 * 设计：永远 CAUTION + 低 confidence，不阻塞但提醒人工介入
 *      explanation 里写明原因，方便排查
 */
function buildSafeFallback(explanation: string): DecisionResult {
  const emptyAudit: AuditSummary = { flags: [], summary: '未评估' };

  return {
    decision: 'CAUTION',
    confidence: CONFIDENCE_FALLBACK,
    source: 'rules',
    businessAudit: emptyAudit,
    financialAudit: emptyAudit,
    feasibilityAudit: emptyAudit,
    requiredActions: [],
    workflowControls: {
      blockProcurement: false,
      blockProduction: false,
      blockShipment: false,
      requireApprovalNodes: [],
      addedRiskMilestones: [],
      increaseReminderFrequency: false,
    },
    rhythmAdjustment: {
      addBufferDays: 0,
      addExtraQc: false,
      requireBackupFactory: false,
    },
    explanation,
    aiUsed: false,
    costUsd: null,
  };
}
