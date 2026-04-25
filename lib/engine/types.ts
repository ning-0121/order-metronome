/**
 * 订单节拍器 — 经营引擎类型定义
 *
 * 三层架构：
 *   1. Root Cause Engine    — 生成订单根因（WHY）
 *   2. Business Decision    — 输出经营决策（WHAT TO DO）
 *   3. Data Asset Layer     — 行业匿名画像（LEARN）
 *
 * 本文件仅类型，无运行时副作用，可安全 import 任意位置。
 */

// ═══════════════════════════════════════════════════════════════
//  Root Cause
// ═══════════════════════════════════════════════════════════════

export type CauseDomain =
  | 'delay'
  | 'profit'
  | 'payment'
  | 'quality'
  | 'confirmation'
  | 'logistics'
  | 'factory'
  | 'customer';

export type CauseType =
  | 'CLIENT_DELAY'
  | 'FACTORY_DELAY'
  | 'MATERIAL_DELAY'
  | 'PACKAGING_DELAY'
  | 'INTERNAL_ERROR'
  | 'LOGISTICS_DELAY'
  | 'PAYMENT_ISSUE'
  | 'QUALITY_ISSUE'
  | 'LOW_MARGIN'
  | 'CONFIRMATION_MISSING';

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export type CauseSource = 'rule' | 'ai' | 'manual';

export type CauseStatus = 'active' | 'confirmed' | 'dismissed' | 'resolved';

export type Stage = 'A' | 'B' | 'C' | 'D';

/** order_root_causes 表的完整 row 类型 */
export interface RootCause {
  id: string;
  order_id: string;
  company_id: string | null;
  cause_domain: CauseDomain;
  cause_type: CauseType;
  cause_code: string;
  cause_title: string;
  cause_description: string | null;
  stage: Stage | null;
  responsible_role: string | null;
  responsible_user_id: string | null;
  impact_days: number;
  impact_cost: number;
  severity: Severity;
  confidence_score: number;
  source: CauseSource;
  evidence_json: Record<string, unknown>;
  status: CauseStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
}

/** 规则评估结果（规则函数返回值） */
export interface CauseEvaluation {
  matched: boolean;
  stage: Stage | null;
  severity: Severity;
  impact_days: number;
  impact_cost: number;
  responsible_role: string | null;
  evidence: Record<string, unknown>;
  confidence: number;
  description?: string;
}

/** 单条规则的元数据 + 评估函数 */
export interface CauseRule {
  code: string;
  domain: CauseDomain;
  type: CauseType;
  title: string;
  evaluate: (ctx: OrderContext) => CauseEvaluation | null;
}

/** Root Cause 引擎扫描的返回值 */
export interface RootCauseScanResult {
  newCauses: number;
  updatedCauses: number;
  resolvedCauses: number;
  errors: string[];
  rulesEvaluated: number;
}

// ═══════════════════════════════════════════════════════════════
//  Business Decision
// ═══════════════════════════════════════════════════════════════

export type DecisionVerdict = 'PROCEED' | 'CAUTION' | 'STOP';

export interface DecisionReason {
  code: string;
  title: string;
  description: string;
  severity: Severity;
  evidence: Record<string, unknown>;
}

export interface DecisionAction {
  action_type: string;          // 与 Agent action types 命名对齐
  title: string;
  description: string;
  owner_role: string;
  requires_approval: boolean;
  risk_level: Severity;
}

export interface DecisionBlocker {
  block_code: string;
  block_title: string;
  block_reason: string;
  next_action: string;
}

export interface BusinessDecision {
  decision: DecisionVerdict;
  priority: Severity;
  confidence: number;            // 0-1
  summary: string;
  reasons: DecisionReason[];
  recommended_actions: DecisionAction[];
  blockers: DecisionBlocker[];
  meta: {
    engine_version: string;
    generated_at: string;
    rules_fired: string[];
    fallback: boolean;
  };
}

// ═══════════════════════════════════════════════════════════════
//  共用：OrderContext（引擎输入）
// ═══════════════════════════════════════════════════════════════

export interface OrderContextSignals {
  overdueCount: number;
  blockedCount: number;
  daysToETD: number | null;
  marginPct: number | null;
  depositReceived: boolean;
  balanceReceived: boolean;
  paymentHold: boolean;
}

/**
 * 引擎运行所需的订单上下文
 * 为避免循环依赖，这里用宽松类型；实际使用时由调用方填充。
 */
export interface OrderContext {
  order: Record<string, unknown>;
  milestones: Array<Record<string, unknown>>;
  financials: Record<string, unknown> | null;
  baseline: Record<string, unknown> | null;
  confirmations: Array<Record<string, unknown>>;
  productionReports?: Array<Record<string, unknown>>;
  activeCauses: RootCause[];
  signals: OrderContextSignals;
}

// ═══════════════════════════════════════════════════════════════
//  Data Asset Layer
// ═══════════════════════════════════════════════════════════════

export interface CustomerAnalytics {
  id: string;
  company_id: string | null;
  customer_id_hash: string;
  customer_segment: string | null;
  country: string | null;
  avg_margin: number | null;
  avg_payment_days: number | null;
  avg_delay_days: number | null;
  confirmation_delay_avg: number | null;
  complaint_rate: number | null;
  repeat_order_rate: number | null;
  risk_score: number | null;
  sample_size: number;
  updated_at: string;
}

export interface FactoryAnalytics {
  id: string;
  company_id: string | null;
  factory_id_hash: string;
  factory_segment: string | null;
  product_category: string | null;
  delay_rate: number | null;
  avg_delay_days: number | null;
  defect_rate: number | null;
  rework_rate: number | null;
  qc_pass_rate: number | null;
  avg_lead_time: number | null;
  capacity_score: number | null;
  risk_score: number | null;
  sample_size: number;
  updated_at: string;
}

export interface OrderModelAnalytics {
  id: string;
  company_id: string | null;
  product_category: string | null;
  country: string | null;
  incoterm: string | null;
  order_size_bucket: string | null;
  margin_avg: number | null;
  margin_p25: number | null;
  margin_p50: number | null;
  margin_p75: number | null;
  delay_avg_days: number | null;
  defect_rate_avg: number | null;
  payment_delay_avg: number | null;
  confirmation_rounds_avg: number | null;
  sample_size: number;
  updated_at: string;
}

export const ENGINE_VERSION = '0.1.0-skeleton';
