/**
 * KPI 计算工具 V1
 *
 * 基于 milestones 表的 status / due_at / completed_at 计算：
 * - 节点准时率
 * - 超期节点数
 * - 完成节点数
 * - 阻塞节点数
 */

import { isDoneStatus, isBlockedStatus, isActiveStatus } from '@/lib/domain/types';

export interface MilestoneKPIInput {
  id: string;
  status: string;
  due_at: string | null;
  completed_at: string | null;
  owner_role: string;
  owner_user_id: string | null;
  order_id: string;
}

export interface KPIResult {
  /** 总节点数 */
  total: number;
  /** 已完成数 */
  completed: number;
  /** 准时完成数（completed_at <= due_at） */
  onTime: number;
  /** 超期完成数（completed_at > due_at） */
  lateCompleted: number;
  /** 当前超期未完成数（status != 已完成 且 due_at < now） */
  overdue: number;
  /** 当前阻塞数 */
  blocked: number;
  /** 准时率（0-100）= onTime / completed * 100 */
  onTimeRate: number;
  /** 完成率（0-100）= completed / total * 100 */
  completionRate: number;
}

/**
 * 计算一组里程碑的 KPI
 */
export function computeKPI(milestones: MilestoneKPIInput[]): KPIResult {
  const now = new Date();
  let completed = 0;
  let onTime = 0;
  let lateCompleted = 0;
  let overdue = 0;
  let blocked = 0;

  let overdueInProgress = 0;

  for (const m of milestones) {
    if (isDoneStatus(m.status)) {
      completed++;
      if (m.due_at && m.completed_at) {
        const due = new Date(m.due_at);
        const done = new Date(m.completed_at);
        if (done <= due) {
          onTime++;
        } else {
          lateCompleted++;
        }
      }
      // 无 due_at 或 无 completed_at 的完成节点不计入准时统计（保守处理）
    } else if (isBlockedStatus(m.status)) {
      blocked++;
      if (m.due_at && new Date(m.due_at) < now) {
        overdue++;
      }
    } else {
      // 未完成、未阻塞（进行中或未开始）
      if (m.due_at && new Date(m.due_at) < now) {
        overdue++;
        if (isActiveStatus(m.status)) overdueInProgress++;
      }
    }
  }

  const total = milestones.length;
  // 统一准时率公式：onTime / (有due_at的已完成数 + 进行中已超期数)
  const completedWithDue = milestones.filter(m => isDoneStatus(m.status) && m.due_at).length;
  const onTimeBase = completedWithDue + overdueInProgress;
  const onTimeRate = onTimeBase > 0 ? Math.round((onTime / onTimeBase) * 100) : -1;
  const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;

  return { total, completed, onTime, lateCompleted, overdue, blocked, onTimeRate, completionRate };
}

/**
 * 按角色分组计算 KPI
 */
export function computeKPIByRole(milestones: MilestoneKPIInput[]): Record<string, KPIResult> {
  const groups: Record<string, MilestoneKPIInput[]> = {};
  for (const m of milestones) {
    const role = m.owner_role || 'unknown';
    if (!groups[role]) groups[role] = [];
    groups[role].push(m);
  }
  const result: Record<string, KPIResult> = {};
  for (const [role, ms] of Object.entries(groups)) {
    result[role] = computeKPI(ms);
  }
  return result;
}

/**
 * 按用户分组计算 KPI
 */
export function computeKPIByUser(milestones: MilestoneKPIInput[]): Record<string, KPIResult> {
  const groups: Record<string, MilestoneKPIInput[]> = {};
  for (const m of milestones) {
    const uid = m.owner_user_id || 'unassigned';
    if (!groups[uid]) groups[uid] = [];
    groups[uid].push(m);
  }
  const result: Record<string, KPIResult> = {};
  for (const [uid, ms] of Object.entries(groups)) {
    result[uid] = computeKPI(ms);
  }
  return result;
}
