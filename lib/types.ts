// Type definitions for Order Metronome (V1)
// Note: MilestoneStatus is now defined in lib/domain/types.ts (只使用中文状态)

export type UserRole = 'sales' | 'finance' | 'procurement' | 'production' | 'qc' | 'logistics' | 'admin';
export type IncotermType = 'FOB' | 'DDP';
export type OrderType = 'sample' | 'bulk';
export type PackagingType = 'standard' | 'custom';
// 状态类型：统一使用中文（兼容旧代码，但推荐使用 lib/domain/types.ts 中的类型）
export type MilestoneStatus = '未开始' | '进行中' | '卡住' | '已完成';
export type DelayRequestStatus = 'pending' | 'approved' | 'rejected';
export type NotificationStatus = 'unread' | 'read';

export interface Profile {
  user_id: string;
  name: string;
  role: UserRole;
  email: string;
  created_at: string;
  updated_at: string;
}

export interface Order {
  id: string;
  order_no: string;
  customer_name: string;
  incoterm: IncotermType;
  etd: string | null; // Required for FOB
  warehouse_due_date: string | null; // Required for DDP
  order_type: OrderType;
  packaging_type: PackagingType;
  created_by: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface Milestone {
  id: string;
  order_id: string;
  step_key: string;
  name: string;
  owner_role: UserRole;
  owner_user_id: string | null;
  planned_at: string | null;
  due_at: string | null;
  status: MilestoneStatus;
  is_critical: boolean;
  evidence_required: boolean;
  notes: string | null; // 统一使用 notes，blocked_reason 已废弃
  created_at: string;
  updated_at: string;
}

export interface MilestoneLog {
  id: string;
  milestone_id: string;
  order_id: string;
  actor_user_id: string;
  action: string;
  note: string | null;
  payload: any | null;
  created_at: string;
}

export interface DelayRequest {
  id: string;
  order_id: string;
  milestone_id: string;
  requested_by: string;
  reason_type: string;
  reason_detail: string;
  proposed_new_anchor_date: string | null;
  proposed_new_due_at: string | null;
  requires_customer_approval: boolean;
  customer_approval_evidence_url: string | null;
  status: DelayRequestStatus;
  approved_by: string | null;
  approved_at: string | null;
  decision_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface Notification {
  id: string;
  milestone_id: string | null;
  order_id: string;
  kind: string;
  sent_to: string;
  sent_at: string;
  payload: any | null;
  created_at: string;
}

export interface OrderAttachment {
  id: string;
  order_id: string;
  milestone_id: string | null;
  uploaded_by: string;
  file_name: string;
  file_url: string;
  file_size: number | null;
  mime_type: string | null;
  created_at: string;
}

// Milestone template definition
export interface MilestoneTemplate {
  step_key: string;
  name: string;
  owner_role: UserRole;
  is_critical: boolean;
  evidence_required: boolean;
  days_before_target: number; // Days before ETD or WarehouseDueDate
}
