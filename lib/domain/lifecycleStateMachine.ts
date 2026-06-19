/**
 * Order Lifecycle State Machine — 合法状态转移 SSOT
 *
 * 历史问题：lifecycle_status 字段无 state machine 校验，可任意跳转
 *   （包括 completed → active 回滚），导致数据状态混乱。
 *
 * 合法转移：
 *   draft ─────┬──→ pending_approval  ─┐
 *              ├──→ active             ├──→ completed ──→ archived
 *              └──→ cancelled  ←───────┘
 *                       ↑
 *                       └─── （active 也可直接 cancelled）
 *
 *   - draft 是新订单初始态，可走「待审批」（进行中导入）或直接 active
 *   - pending_approval（进行中导入待审批）可批准变 active 或拒绝变 cancelled
 *   - active 是执行中，正常完成 → completed；客户取消 → cancelled
 *   - completed 是终态，admin 可归档变 archived
 *   - cancelled / archived 是真终态，不允许出
 *
 * 中文枚举（已完成/已取消/已归档）历史数据：通过 isTerminalLifecycle 等容错。
 * 写库的新值都用英文枚举（migration 已归一化）。
 */

import { isDoneLifecycle, isCancelledLifecycle } from './lifecycleStatus';

export type LifecycleStatus =
  | 'draft'
  | 'pending_approval'
  | 'active'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'archived';

/**
 * 合法的状态转移图
 * key = 当前状态，value = 允许迁移到的下一个状态集合
 */
export const LIFECYCLE_TRANSITIONS: Record<LifecycleStatus, LifecycleStatus[]> = {
  draft:            ['pending_approval', 'active', 'cancelled'],
  pending_approval: ['active', 'cancelled', 'draft'],   // 拒绝可退回 draft
  active:           ['completed', 'cancelled', 'paused'],
  paused:           ['active', 'cancelled'],             // 治理台暂停，可恢复或取消
  completed:        ['archived'],
  cancelled:        [],   // 终态
  archived:         [],   // 终态
};

/**
 * 状态语义中文标签
 */
export const LIFECYCLE_LABEL: Record<LifecycleStatus, string> = {
  draft:            '草稿',
  pending_approval: '待审批',
  active:           '执行中',
  paused:           '已暂停',
  completed:        '已完成',
  cancelled:        '已取消',
  archived:         '已归档',
};

/**
 * 把外部字符串（含中文/未知）归一化为合法的 LifecycleStatus
 * 未识别返回 null
 */
export function normalizeLifecycleEnum(s: string | null | undefined): LifecycleStatus | null {
  if (!s) return null;
  const mapped: Record<string, LifecycleStatus> = {
    'draft': 'draft',
    '草稿': 'draft',
    'pending_approval': 'pending_approval',
    '待审批': 'pending_approval',
    'active': 'active',
    '执行中': 'active',
    'paused': 'paused',
    '已暂停': 'paused',
    'completed': 'completed',
    '已完成': 'completed',
    'cancelled': 'cancelled',
    '已取消': 'cancelled',
    'archived': 'archived',
    '已归档': 'archived',
  };
  return mapped[s] ?? null;
}

/**
 * 判断 from → to 是否合法的状态转移
 * @param adminOverride 如果 admin 强制覆盖（如修复脏数据），允许任意转移
 */
export function canTransition(
  from: string | null | undefined,
  to: string | null | undefined,
  adminOverride = false,
): boolean {
  if (adminOverride) return true;

  const fromNorm = normalizeLifecycleEnum(from);
  const toNorm = normalizeLifecycleEnum(to);

  // 起点未识别：保守允许（可能是历史脏数据）
  if (!fromNorm) return true;
  // 终点未识别：拒绝
  if (!toNorm) return false;

  // 相同状态：no-op，允许
  if (fromNorm === toNorm) return true;

  // 查转移表
  return LIFECYCLE_TRANSITIONS[fromNorm].includes(toNorm);
}

/**
 * 校验状态转移，返回错误消息（合法时返回 null）
 *
 * 用法：
 *   const err = validateTransition(order.lifecycle_status, newStatus);
 *   if (err) return { error: err };
 */
export function validateTransition(
  from: string | null | undefined,
  to: string | null | undefined,
  adminOverride = false,
): string | null {
  if (canTransition(from, to, adminOverride)) return null;

  const fromNorm = normalizeLifecycleEnum(from);
  const toNorm = normalizeLifecycleEnum(to);
  const fromLabel = fromNorm ? LIFECYCLE_LABEL[fromNorm] : (from || '未知');
  const toLabel = toNorm ? LIFECYCLE_LABEL[toNorm] : (to || '未知');

  // 特定常见错误的友好提示
  if (isDoneLifecycle(from) && to === 'active') {
    return `不允许把「${fromLabel}」订单回滚到「${toLabel}」（已完成订单不可重新激活）。如需修改请联系管理员强制操作。`;
  }
  if (isCancelledLifecycle(from)) {
    return `不允许把「${fromLabel}」订单转换为其他状态（取消是终态）。如需恢复请管理员强制操作。`;
  }

  return `不允许的状态转移：${fromLabel} → ${toLabel}。当前状态允许转换为：${
    fromNorm ? LIFECYCLE_TRANSITIONS[fromNorm].map(s => LIFECYCLE_LABEL[s]).join(' / ') || '无（终态）' : '未知'
  }`;
}
