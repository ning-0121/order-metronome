/**
 * Order Decision Engine — 类型定义
 *
 * 设计原则：
 *   1. 严格类型边界（决策结果 / 规则 ID / 用户动作 等用 union 锁死）
 *   2. 原始 DB 行用 Record<string, any>（与项目现有"as any"模式一致）
 *   3. AI 相关接口 Phase 1.0 仅占位，不实现
 *   4. 所有跨层数据结构集中此处，避免散落在 service / engine / action / UI
 *
 * Phase 1.0 范围（用户最终确认）：
 *   - 8 条规则（Rule 6 拆 4 子规则 → 实际 11 条 RuleFlag id）
 *   - 仅规则路径，不接 AI（AiVerdict 等占位）
 *   - 仅 admin 可见，feature flag 控制
 *   - 不真阻塞 workflow（workflowControls 仅前端展示）
 */

// ═══════════════════════════════════════════════════════════════════════
// 核心枚举
// ═══════════════════════════════════════════════════════════════════════

/** 决策三态 */
export type DecisionValue = 'PROCEED' | 'CAUTION' | 'STOP';

/** 严重度 */
export type Severity = 'high' | 'medium' | 'low';

/** 三大审核类别（与 DB business_audit/financial_audit/feasibility_audit 三列对齐） */
export type AuditCategory = 'business' | 'financial' | 'feasibility';

/** 行动紧急度 */
export type ActionUrgency = 'now' | 'within_24h' | 'within_3d';

/** 评审类型（与 DB review_type CHECK 约束对齐） */
export type ReviewType = 'pre_kickoff' | 'mid_production' | 'pre_shipment' | 'manual';

/** 触发源（与 DB triggered_by CHECK 约束对齐） */
export type TriggeredBy = 'manual' | 'field_change' | 'milestone_event';

/** Override 状态 */
export type OverrideStatus = 'pending' | 'approved' | 'rejected';

/** 用户对 review 的反馈动作（与 DB user_action CHECK 约束对齐） */
export type UserAction =
  | 'accept'
  | 'override_to_proceed'
  | 'override_to_stop'
  | 'request_review'
  | 'ignore';

/** 订单最终结果（与 DB final_result CHECK 约束对齐） */
export type FinalResult = 'success' | 'delayed' | 'loss' | 'rework' | 'cancelled';

// ═══════════════════════════════════════════════════════════════════════
// 规则层
// ═══════════════════════════════════════════════════════════════════════

/**
 * 规则 ID — Phase 1.0 共 11 条（8 条核心规则，其中 Rule 6 拆 4 子规则）
 *
 * 用户最终确认的规则集（2026-04-28）：
 *   Rule 1 → three_doc_price_mismatch
 *   Rule 2 → margin_below_5pct
 *   Rule 3 → margin_5_to_8pct
 *   Rule 4 → deposit_not_received_pre_production
 *   Rule 5 → balance_not_received_pre_shipment
 *   Rule 6 拆 4 子：
 *     6.1 → fabric_color_missing
 *     6.2 → size_breakdown_missing
 *     6.3 → logo_artwork_missing
 *     6.4 → packaging_label_missing
 *   Rule 7 → factory_capacity_risk
 *   Rule 8 → new_customer_complex_no_deposit
 */
export type RuleFlagId =
  | 'three_doc_price_mismatch'
  | 'margin_below_5pct'
  | 'margin_5_to_8pct'
  | 'deposit_not_received_pre_production'
  | 'balance_not_received_pre_shipment'
  | 'fabric_color_missing'
  | 'size_breakdown_missing'
  | 'logo_artwork_missing'
  | 'packaging_label_missing'
  | 'factory_capacity_risk'
  | 'new_customer_complex_no_deposit';

/**
 * 单条规则触发输出
 *
 * - decision：本规则单独判断会下什么决策（用于 engine 合并时取最严的）
 * - blockedMilestone：本规则阻塞哪个 milestone（Rule 6 子规则必填）
 * - nextAction：触发该规则后的下一步动作（用户可见）
 */
export interface RuleFlag {
  id: RuleFlagId;
  category: AuditCategory;
  severity: Severity;
  decision: DecisionValue;
  message: string;
  evidence: string;
  blockedMilestone?: string;
  nextAction?: string;
}

/**
 * 规则引擎输出
 *
 * preliminaryDecision：
 *   - 'PROCEED' / 'CAUTION' / 'STOP' → 规则可以独立定夺，不需要 AI
 *   - 'NEEDS_AI' → 规则有冲突或数据不足，需要 AI 介入（Phase 1.0 不会出现这个值）
 */
export interface RulesPrediction {
  flags: RuleFlag[];
  whetherAiNeeded: boolean;
  aiReason: string | null;
  preliminaryDecision: DecisionValue | 'NEEDS_AI';
}

// ═══════════════════════════════════════════════════════════════════════
// AI 层（Phase 1.0 占位，不实现）
// ═══════════════════════════════════════════════════════════════════════

/** AI 推荐的下一步行动 */
export interface RecommendedAction {
  action: string;
  targetRole: string;
  urgency: ActionUrgency;
}

/** AI 输出（Phase 1.0 不会真正生成） */
export interface AiVerdict {
  decision: DecisionValue;
  confidence: number; // 0-100
  reasoning: string;
  keyConcerns: string[];
  recommendedActions: RecommendedAction[];
  caveats?: string;
}

/** AI 调用配置（Phase 1.1+ 启用） */
export interface AiCallOptions {
  riskLevel: 'medium' | 'high';
  cacheKey: string;
  timeoutMs?: number;
}

/** AI 调用结果（Phase 1.1+ 启用） */
export type AiCallResult =
  | {
      ok: true;
      verdict: AiVerdict;
      meta: {
        model: string;
        inputTokens: number;
        outputTokens: number;
        cacheHit: boolean;
        costUsd: number;
      };
    }
  | {
      ok: false;
      error: string;
      fallback: AiVerdict;
    };

// ═══════════════════════════════════════════════════════════════════════
// 引擎层 — 最终决策结果
// ═══════════════════════════════════════════════════════════════════════

/** 单个审核类别的汇总（business / financial / feasibility 各一份） */
export interface AuditSummary {
  flags: RuleFlag[];
  summary: string;
}

/**
 * Workflow 控制建议
 *
 * Phase 1.0 警告：这些字段仅用于 UI 展示，**不会**真实 enforce 到 server action。
 * Phase 2 才会接入 procurement / production / shipment 的硬阻塞。
 */
export interface WorkflowControls {
  blockProcurement: boolean;
  blockProduction: boolean;
  blockShipment: boolean;
  requireApprovalNodes: string[];
  addedRiskMilestones: string[];
  increaseReminderFrequency: boolean;
}

/**
 * 节拍调整建议
 *
 * Phase 1.0 警告：仅用于 UI 展示，不会真实改 milestone 模板生成。
 * Phase 2 接入里程碑生成函数后才生效。
 */
export interface RhythmAdjustment {
  addBufferDays: number;
  addExtraQc: boolean;
  requireBackupFactory: boolean;
}

/** 引擎最终输出（持久化到 order_decision_reviews.result_json） */
export interface DecisionResult {
  decision: DecisionValue;
  confidence: number; // 0-100
  source: 'rules' | 'ai' | 'rules+ai';
  businessAudit: AuditSummary;
  financialAudit: AuditSummary;
  feasibilityAudit: AuditSummary;
  requiredActions: RecommendedAction[];
  workflowControls: WorkflowControls;
  rhythmAdjustment: RhythmAdjustment;
  explanation: string;
  aiUsed: boolean;
  costUsd: number | null;
}

// ═══════════════════════════════════════════════════════════════════════
// Context 层 — 决策引擎的输入数据
// ═══════════════════════════════════════════════════════════════════════

/** 同客户/工厂近 6 单的简要历史（用于规则判断） */
export interface SimilarOrderSummary {
  orderNo: string;
  customerName: string | null;
  delayDays: number | null;
  actualMarginPct: number | null;
  finalResult: FinalResult | null;
}

/** Context 元数据（数据完整度自检） */
export interface ContextMeta {
  fetchedAt: string;
  completeness: {
    hasFinancials: boolean;
    hasCostBaseline: boolean;
    hasCustomerProfile: boolean;
    hasFactoryProfile: boolean;
    hasConfirmations: boolean;
    hasProcurementItems: boolean;
    missingFields: string[]; // 例：['cost_baseline', 'customer_behavior_profile']
  };
}

/**
 * 决策引擎输入上下文
 *
 * 数据来源（9 张表）：
 *   1. orders                              — 订单主表
 *   2. order_confirmations                 — 确认链
 *   3. order_financials                    — 财务汇总
 *   4. order_cost_baseline                 — 成本基线（migration 01）
 *   5. procurement_line_items              — 采购明细（migration 02）
 *   6. customer_behavior_profile           — 客户画像（Phase 2 才建表，目前 null）
 *   7. factory_capability_profile          — 工厂能力（Phase 2 才建表，目前 null）
 *   8. order_root_causes                   — 历史 root cause
 *   9. orders + order_outcome_reviews JOIN — 同客户/工厂近 6 单
 *
 * 注：DB 行类型用 Record<string, any> 与项目现有 supabase as any 模式一致；
 *     需要严格类型时可在使用方 narrowing。
 */
export interface OrderDecisionContext {
  order: Record<string, any>;
  confirmations: Record<string, any>[];
  financials: Record<string, any> | null;
  costBaseline: Record<string, any> | null;
  procurementItems: Record<string, any>[];
  customerProfile: Record<string, any> | null;
  factoryProfile: Record<string, any> | null;
  rootCauses: Record<string, any>[];
  similarOrders: SimilarOrderSummary[];
  meta: ContextMeta;
}

// ═══════════════════════════════════════════════════════════════════════
// 引擎运行选项
// ═══════════════════════════════════════════════════════════════════════

export interface RunDecisionOptions {
  triggeredBy: TriggeredBy;
  triggeredField?: string;
  forceFresh?: boolean; // 跳过 24h 缓存
  reviewType?: ReviewType;
}

// ═══════════════════════════════════════════════════════════════════════
// 持久化层 — 与 DB 行映射（最小集，仅引擎/服务直接用到的字段）
// ═══════════════════════════════════════════════════════════════════════

/**
 * order_decision_reviews 行的"读视图"（select 出来的形态）
 * 仅列出引擎/UI 会消费的字段，其余字段需要时直接 select '*'
 */
export interface OrderDecisionReviewRow {
  id: string;
  order_id: string;
  review_type: ReviewType;
  input_hash: string;
  triggered_by: TriggeredBy;
  triggered_field: string | null;

  decision: DecisionValue;
  confidence: number;
  business_audit: AuditSummary;
  financial_audit: AuditSummary;
  feasibility_audit: AuditSummary;
  result_json: DecisionResult;
  rule_flags: RuleFlag[];

  ai_used: boolean;
  ai_model_used: string | null;
  ai_call_count: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_hit_tokens: number | null;
  cost_usd: number | null;

  override_status: OverrideStatus | null;
  override_by: string | null;
  override_reason: string | null;
  override_at: string | null;

  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * decision_feedback 行的"写视图"（insert 时构造的形态）
 */
export interface DecisionFeedbackInsert {
  decision_review_id: string;
  user_action: UserAction;
  override_reason?: string | null;
  was_decision_correct?: boolean | null;
  final_outcome?: FinalResult | null;
  feedback_by: string;
}
