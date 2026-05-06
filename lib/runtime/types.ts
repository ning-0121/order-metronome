/**
 * Runtime Engine Phase 1 — 类型定义
 *
 * 这些类型对应 runtime_events / runtime_orders DB schema，并被
 * deliveryConfidence engine + UI 共用。
 */

// ─────────────────────────────────────────────────────────────
// runtime_events
// ─────────────────────────────────────────────────────────────

export type RuntimeEventType =
  | 'milestone_status_changed'  // milestone status / due_at 变更
  | 'delay_approved'             // delay_request 被批准
  | 'anchor_changed'             // orders.factory_date / etd / warehouse_due_date 变更
  | 'amendment_applied'          // order_amendments 应用
  | 'external_signal';           // 外部触发（手动重算 / 后台扫描）

export type RuntimeEventSeverity = 'info' | 'warning' | 'critical';

export interface RuntimeEvent {
  id?: string;
  order_id: string;
  event_type: RuntimeEventType;
  event_source?: string | null;       // 'milestone:<id>' | 'delay_request:<id>' | 'manual' | ...
  severity?: RuntimeEventSeverity;
  payload_json?: Record<string, any> | null;
  created_by?: string | null;
  created_at?: string;
}

// ─────────────────────────────────────────────────────────────
// explain_json — 人类可读解释（员工和老板都能看懂）
// ─────────────────────────────────────────────────────────────

export interface ConfidenceReason {
  code: string;          // 机器可处理的 code，如 'critical_step_overdue' / 'buffer_consumed'
  label: string;         // 人类可读，如 '【大货启动】已超期 3 天'
  delta: number;         // 该项扣分 / 加分（负数为扣分）
  weight: 'critical' | 'high' | 'medium' | 'low';
}

export interface NextBlocker {
  step_key: string;
  name: string;
  due_at: string | null;
  status: string;
  owner_role: string | null;
  daysOverdue: number;
  daysUntil: number;
}

export interface ConfidenceExplain {
  headline: string;                       // 一句话总结，如 "🟡 交付有风险（67%）"
  reasons: ConfidenceReason[];            // 扣分明细（按 |delta| 降序）
  next_blocker: NextBlocker | null;       // 下一个挡路的关键节点
  next_action: string | null;             // 下一步建议，如 "采购催面料 / 业务确认是否换供应商"
  computed_at: string;                    // ISO 时间
}

// ─────────────────────────────────────────────────────────────
// runtime_orders
// ─────────────────────────────────────────────────────────────

export type RuntimeRiskLevel = 'green' | 'yellow' | 'orange' | 'red' | 'gray';

export interface RuntimeOrderState {
  order_id: string;
  delivery_confidence: number | null;     // 0-100
  risk_level: RuntimeRiskLevel;
  predicted_finish_date: string | null;   // YYYY-MM-DD
  buffer_days: number | null;             // 距出厂日的剩余缓冲天数
  last_event_id: string | null;
  last_recomputed_at: string;
  explain_json: ConfidenceExplain | null;
  version: number;
  updated_at: string;
}

// ─────────────────────────────────────────────────────────────
// 计算引擎输入
// ─────────────────────────────────────────────────────────────

export interface ConfidenceComputeInput {
  order: any;
  milestones: any[];
  financials?: any | null;
  delayRequests?: any[];
  triggeringEvent?: RuntimeEvent;
  now?: Date;
}

export interface ConfidenceComputeOutput {
  confidence: number;
  riskLevel: RuntimeRiskLevel;
  predictedFinishDate: string | null;
  bufferDays: number | null;
  explain: ConfidenceExplain;
}
