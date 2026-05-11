// ============================================================
// Trade OS — Service Layer 统一类型定义
// 所有 service 共用，不在页面组件里重复定义
// ============================================================

// ─── 通用 ────────────────────────────────────────────────────

export type ServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string }

export function ok<T>(data: T): ServiceResult<T> {
  return { ok: true, data }
}
export function err(error: string, code?: string): ServiceResult<never> {
  return { ok: false, error, code }
}

// ─── system_alerts ────────────────────────────────────────────

export type AlertType =
  | 'low_margin'
  | 'negative_margin'
  | 'order_overdue'
  | 'milestone_stuck'
  | 'customer_inactive'
  | 'customer_at_risk'
  | 'email_urgent'
  | 'approval_pending'
  | 'system_error'

export type AlertSeverity = 'info' | 'warning' | 'critical'

export type AlertEntityType = 'order' | 'customer' | 'factory' | 'system'

export interface SystemAlert {
  id: string
  alert_type: AlertType
  severity: AlertSeverity
  entity_type: AlertEntityType | null
  entity_id: string | null
  title: string
  description: string | null
  data_json: Record<string, any>
  alert_key: string | null
  is_read: boolean
  is_resolved: boolean
  resolved_at: string | null
  resolved_by: string | null
  auto_resolve_at: string | null
  created_at: string
}

export interface CreateAlertInput {
  alertType: AlertType
  severity: AlertSeverity
  entityType?: AlertEntityType
  entityId?: string
  title: string
  description?: string
  data?: Record<string, any>
  autoResolveHours?: number
}

// ─── customer_rhythm ──────────────────────────────────────────

export type CustomerTier = 'A' | 'B' | 'C'

export type FollowupStatus = 'normal' | 'due' | 'overdue' | 'at_risk' | 'inactive'

export interface CustomerRhythm {
  id: string
  customer_name: string
  tier: CustomerTier
  last_contact_at: string | null
  next_followup_at: string | null
  followup_interval_days: number
  followup_status: FollowupStatus
  total_order_count: number
  total_order_value_usd: number
  avg_order_value_usd: number
  last_order_at: string | null
  active_order_count: number
  risk_score: number
  risk_factors: RiskFactor[]
  notes: string | null
  updated_at: string
  created_at: string
}

export interface RiskFactor {
  type: string
  description: string
  weight: number  // 0-100
}

export interface CustomerRhythmSyncResult {
  updated: number
  created: number
  errors: string[]
}

// ─── profit_snapshots ─────────────────────────────────────────

export type SnapshotType = 'forecast' | 'live' | 'final'

export type MarginStatus = 'healthy' | 'warning' | 'critical' | 'negative' | 'unset'

export interface ProfitSnapshot {
  id: string
  order_id: string
  snapshot_type: SnapshotType
  revenue_usd: number | null
  revenue_cny: number | null
  exchange_rate: number
  material_cost: number
  processing_cost: number
  logistics_cost: number
  other_cost: number
  total_cost: number | null
  gross_profit: number | null
  gross_margin: number | null
  margin_status: MarginStatus
  data_completeness: number
  missing_fields: string[]
  version: number
  notes: string | null
  created_at: string
  updated_at: string
}

export interface ProfitCalculationResult {
  snapshot: ProfitSnapshot
  marginStatus: MarginStatus
  shouldAlert: boolean
  alertSeverity: AlertSeverity | null
  dataCompleteness: number
  missingFields: string[]
}

export interface ProfitInput {
  orderId: string
  snapshotType: SnapshotType
  overrides?: Partial<{
    revenueUsd: number
    revenueCny: number
    exchangeRate: number
    materialCost: number
    processingCost: number
    logisticsCost: number
    otherCost: number
  }>
}

// ─── ai_context_cache ─────────────────────────────────────────

export type ContextType = 'customer' | 'order' | 'factory' | 'product' | 'global'

export interface AIContextCache {
  id: string
  context_type: ContextType
  entity_id: string
  summary_json: Record<string, any>
  raw_context_text: string | null
  token_estimate: number
  model_used: string | null
  last_updated_at: string
  valid_until: string | null
  is_stale: boolean
  invalidation_reason: string | null
  version: number
}

export interface GetContextOptions {
  forceRefresh?: boolean
  maxTokens?: number
  ttlHours?: number  // 缓存有效期，默认 24h
}

export interface ContextResult {
  text: string
  summaryJson: Record<string, any>
  fromCache: boolean
  tokenEstimate: number
  lastUpdatedAt: string
}

// ─── email_process_log ────────────────────────────────────────

export type EmailActionType =
  | 'inquiry'
  | 'followup'
  | 'complaint'
  | 'approval'
  | 'payment'
  | 'info'
  | 'other'
  | 'none'

export type UrgencyLevel = 'urgent' | 'normal' | 'low'

export interface EmailProcessLog {
  id: string
  email_uid: string
  message_id: string | null
  subject: string | null
  from_email: string | null
  received_at: string | null
  processed_at: string
  customer_detected: string | null
  order_detected: string | null
  action_type: EmailActionType | null
  urgency_level: UrgencyLevel
  summary_text: string | null
  requires_action: boolean
  action_description: string | null
  token_used: number
  model_used: string | null
  error_message: string | null
}

export interface RawEmail {
  uid: string
  messageId?: string
  subject: string
  from: string
  body: string
  receivedAt: Date
}

export interface EmailAnalysisResult {
  actionType: EmailActionType
  urgencyLevel: UrgencyLevel
  customerDetected: string | null
  orderDetected: string | null
  summaryText: string
  requiresAction: boolean
  actionDescription: string | null
  tokenUsed: number
}

export interface EmailProcessResult {
  processed: number
  skipped: number
  tokensUsed: number
  actionsFound: number
  errors: string[]
}

// ─── daily_tasks ──────────────────────────────────────────────

export type TaskType =
  | 'milestone_overdue'
  | 'milestone_due_today'
  | 'customer_followup'
  | 'delay_approval'
  | 'quote_approval'
  | 'profit_warning'
  | 'system_alert'
  | 'email_action'
  | 'missing_info'
  | 'decision_required'

export type TaskPriority = 1 | 2 | 3

export type TaskStatus = 'pending' | 'done' | 'snoozed' | 'dismissed'

export interface DailyTask {
  id: string
  assigned_to: string
  task_date: string
  task_type: TaskType
  priority: TaskPriority
  title: string
  description: string | null
  action_url: string | null
  action_label: string
  related_order_id: string | null
  related_customer: string | null
  related_milestone_id: string | null
  source_type: string | null
  source_id: string | null
  status: TaskStatus
  completed_at: string | null
  snoozed_until: string | null
  created_at: string
}

export interface CreateTaskInput {
  assignedTo: string
  taskDate?: string  // YYYY-MM-DD，默认今天
  taskType: TaskType
  priority: TaskPriority
  title: string
  description?: string
  actionUrl?: string
  actionLabel?: string
  relatedOrderId?: string
  relatedCustomer?: string
  relatedMilestoneId?: string
  sourceType: string
  sourceId: string
}

export type TaskGenerationTrigger =
  | { trigger: 'daily_cron'; date: string }
  | { trigger: 'milestone_update'; milestoneId: string; orderId: string }
  | { trigger: 'order_created'; orderId: string }
  | { trigger: 'order_updated'; orderId: string }
  | { trigger: 'delay_request'; delayRequestId: string; orderId: string }
  | { trigger: 'customer_rhythm_update'; customerName: string }

export interface TaskGenerationResult {
  created: number
  skipped: number  // 因 UNIQUE 约束去重
  errors: string[]
}
