/**
 * Phase 1 AI Agent — 类型定义
 *
 * 8 种可执行动作，每种都是低风险、可回滚的操作。
 * 绝对禁止：修改金额/价格/客户信息、删除数据、自动审批、联系客户。
 */

export type AgentActionType =
  | 'assign_owner'        // 分配负责人
  | 'send_nudge'          // 发送催办
  | 'create_delay_draft'  // 创建延期申请草稿
  | 'mark_blocked'        // 标记节点阻塞
  | 'add_note'            // 添加内部备注
  | 'escalate_ceo'        // 升级给 CEO
  | 'notify_next'         // 通知下一节点负责人
  | 'remind_missing_doc'  // 提醒缺失资料
  | 'compliance_alert';   // 邮件-订单执行对照告警

export type AgentActionStatus = 'pending' | 'executing' | 'executed' | 'dismissed' | 'expired';
export type AgentSeverity = 'high' | 'medium' | 'low';

export interface AgentSuggestion {
  id: string;
  orderId: string;
  orderNo: string;
  milestoneId?: string;
  milestoneName?: string;

  actionType: AgentActionType;
  title: string;
  description: string;
  reason: string;
  severity: AgentSeverity;

  // 按钮配置
  primaryButton: {
    label: string;
    confirmMessage?: string; // 非空 = 点击后弹确认框
  };

  // 执行参数
  payload: Record<string, any>;

  status: AgentActionStatus;
  executedAt?: string;
  canRollback: boolean;
}

/**
 * 每种 action_type 的按钮和确认配置
 */
export const ACTION_CONFIG: Record<AgentActionType, {
  icon: string;
  buttonLabel: string;
  confirmMessage?: string;
  canRollback: boolean;
  requiredRoles: string[]; // 空 = 所有角色可执行
}> = {
  assign_owner: {
    icon: '👤',
    buttonLabel: '一键分配',
    canRollback: true,
    requiredRoles: ['admin', 'production_manager'],
  },
  send_nudge: {
    icon: '📧',
    buttonLabel: '发送催办',
    canRollback: false,
    requiredRoles: [],
  },
  create_delay_draft: {
    icon: '⏱',
    buttonLabel: '创建延期申请',
    confirmMessage: '确认创建延期申请草稿？创建后需管理员审批。',
    canRollback: true,
    requiredRoles: [],
  },
  mark_blocked: {
    icon: '🚧',
    buttonLabel: '标记阻塞',
    confirmMessage: '确认标记该节点为阻塞状态？',
    canRollback: true,
    requiredRoles: [],
  },
  add_note: {
    icon: '📝',
    buttonLabel: '添加备注',
    canRollback: true,
    requiredRoles: [],
  },
  escalate_ceo: {
    icon: '🚨',
    buttonLabel: '升级CEO',
    confirmMessage: '确认将此订单升级到CEO关注？',
    canRollback: false,
    requiredRoles: ['admin'],
  },
  notify_next: {
    icon: '📢',
    buttonLabel: '通知负责人',
    canRollback: false,
    requiredRoles: [],
  },
  remind_missing_doc: {
    icon: '📎',
    buttonLabel: '提醒上传',
    canRollback: false,
    requiredRoles: ['admin', 'sales'],
  },
  compliance_alert: {
    icon: '🔍',
    buttonLabel: '查看详情',
    canRollback: false,
    requiredRoles: [],
  },
};

/**
 * 熔断限制
 */
export const CIRCUIT_BREAKER = {
  maxPerOrderPerDay: 5,     // 单订单每天最多执行 5 个建议
  maxGlobalPerHour: 20,     // 全系统每小时最多执行 20 个
  maxSuggestionsPerOrder: 3, // 每单最多 3 条 pending 建议
  expirationHours: 24,      // 建议 24 小时后过期
};
