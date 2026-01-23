/**
 * Domain Types - 领域模型类型定义
 * 这是系统的"单一真实来源"（Single Source of Truth）
 */

// 里程碑状态（只使用中文，统一标准）
export type MilestoneStatus = '未开始' | '进行中' | '卡住' | '已完成';

// 订单生命周期状态（只使用中文，统一标准）
export type OrderLifecycleStatus = '草稿' | '已生效' | '执行中' | '已完成' | '已取消' | '待复盘' | '已复盘';

// 角色类型
export type OwnerRole = 'sales' | 'finance' | 'procurement' | 'production' | 'qc' | 'logistics' | 'admin';

// 状态转换映射（用于兼容旧代码中的英文状态）
export const STATUS_MAP: Record<string, MilestoneStatus> = {
  'not_started': '未开始',
  'in_progress': '进行中',
  'blocked': '卡住',
  'done': '已完成',
  // 中文状态直接映射
  '未开始': '未开始',
  '进行中': '进行中',
  '卡住': '卡住',
  '已完成': '已完成',
};

/**
 * 将任意状态字符串标准化为 MilestoneStatus
 */
export function normalizeMilestoneStatus(status: string | null | undefined): MilestoneStatus {
  if (!status) return '未开始';
  
  const normalized = status.trim();
  
  // 如果已经在映射表中，直接返回
  if (STATUS_MAP[normalized]) {
    return STATUS_MAP[normalized];
  }
  
  // 尝试小写匹配
  const lowerNormalized = normalized.toLowerCase();
  if (STATUS_MAP[lowerNormalized]) {
    return STATUS_MAP[lowerNormalized];
  }
  
  // 默认返回未开始
  return '未开始';
}

/**
 * 状态转换规则定义
 */
export const STATUS_TRANSITIONS: Record<MilestoneStatus, MilestoneStatus[]> = {
  '未开始': ['进行中', '卡住'],
  '进行中': ['卡住', '已完成'],
  '卡住': ['进行中'],
  '已完成': [], // 已完成状态不允许转换
};

/**
 * 检查状态转换是否合法
 */
export function isValidStatusTransition(
  from: MilestoneStatus,
  to: MilestoneStatus
): boolean {
  const allowedTransitions = STATUS_TRANSITIONS[from];
  return allowedTransitions.includes(to);
}

/**
 * 状态转换错误信息
 */
export function getStatusTransitionError(
  from: MilestoneStatus,
  to: MilestoneStatus
): string {
  const allowedTransitions = STATUS_TRANSITIONS[from];
  
  if (allowedTransitions.length === 0) {
    return `状态"${from}"不允许转换（已完成状态是终态）`;
  }
  
  return `状态"${from}"不能转换为"${to}"。允许的转换：${allowedTransitions.join('、')}`;
}

// =========================
// 订单生命周期状态机
// =========================

/**
 * 订单生命周期状态转换规则
 */
export const ORDER_LIFECYCLE_TRANSITIONS: Record<OrderLifecycleStatus, OrderLifecycleStatus[]> = {
  '草稿': ['已生效'],
  '已生效': ['执行中'],
  '执行中': ['已完成', '已取消'],
  '已完成': ['待复盘'],
  '已取消': ['待复盘'],
  '待复盘': ['已复盘'],
  '已复盘': [], // 已复盘是终态
};

/**
 * 检查订单生命周期状态转换是否合法
 */
export function isValidOrderLifecycleTransition(
  from: OrderLifecycleStatus,
  to: OrderLifecycleStatus
): boolean {
  const allowedTransitions = ORDER_LIFECYCLE_TRANSITIONS[from];
  return allowedTransitions.includes(to);
}

/**
 * 订单生命周期状态转换错误信息
 */
export function getOrderLifecycleTransitionError(
  from: OrderLifecycleStatus,
  to: OrderLifecycleStatus
): string {
  const allowedTransitions = ORDER_LIFECYCLE_TRANSITIONS[from];
  
  if (allowedTransitions.length === 0) {
    return `订单状态"${from}"不允许转换（终态）`;
  }
  
  return `订单状态"${from}"不能转换为"${to}"。允许的转换：${allowedTransitions.join('、')}`;
}

/**
 * 订单生命周期状态转换函数
 * @returns {ok: boolean, error?: string}
 */
export function transitionOrderLifecycle(
  from: OrderLifecycleStatus,
  to: OrderLifecycleStatus
): { ok: boolean; error?: string } {
  if (from === to) {
    return { ok: true };
  }
  
  if (!isValidOrderLifecycleTransition(from, to)) {
    return {
      ok: false,
      error: getOrderLifecycleTransitionError(from, to),
    };
  }
  
  return { ok: true };
}

/**
 * 检查订单状态是否允许里程碑变更
 * 只有'已生效'和'执行中'状态的订单才允许里程碑状态变更
 */
export function canModifyMilestones(status: OrderLifecycleStatus): boolean {
  return status === '已生效' || status === '执行中';
}
