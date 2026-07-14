import { isAfter, isBefore, differenceInHours, differenceInCalendarDays, startOfDay } from 'date-fns';
import type { Milestone } from '@/lib/types';
import { computeDeliveryAlert } from '@/lib/domain/milestone-helpers';
import { isDoneStatus, isActiveStatus, isBlockedStatus, isPendingStatus } from '@/lib/domain/types';

export type OrderStatusColor = 'GREEN' | 'YELLOW' | 'RED';

export interface OrderStatus {
  color: OrderStatusColor;
  reason: string;
  /** 具体风险因子列表，供UI展示 */
  riskFactors: string[];
}

export interface RedCulprit { name: string; daysOverdue: number; kind: 'blocked' | 'overdue' }

/**
 * 揪出把订单拖红的节点:阻塞 + 超期的「进行中」节点(带逾期天数)。
 * 与 computeOrderStatus 的 RED 条件 1/2 同口径,供列表红牌提示 + 红单体检面板共用。
 */
export function getRedCulprits(milestones: Milestone[], now: Date = new Date()): RedCulprit[] {
  const out: RedCulprit[] = [];
  for (const m of milestones || []) {
    if (isBlockedStatus(m.status)) { out.push({ name: m.name, daysOverdue: 0, kind: 'blocked' }); continue; }
    if (isActiveStatus(m.status) && m.due_at && isAfter(startOfDay(now), startOfDay(new Date(m.due_at)))) {
      out.push({ name: m.name, daysOverdue: differenceInCalendarDays(startOfDay(now), startOfDay(new Date(m.due_at))), kind: 'overdue' });
    }
  }
  return out;
}

/**
 * 订单风险预判算法（三色灯）
 *
 * 🔴 RED（已发生问题）：
 *   - 存在阻塞节点
 *   - 存在进行中但已超期的节点
 *   - 实际日期偏差>3天（交期高风险）
 *
 * 🟡 YELLOW（风险预警，需要关注和干预）：
 *   - 进行中节点距到期≤3个工作日（72小时窗口）
 *   - 节点已超过计划时间 planned_at（进度偏差）
 *   - 实际日期偏差1-3天（交期黄灯）
 *   - 进行中节点无负责人（无人认领）
 *   - 需要凭证但距到期≤5天未上传
 *   - 订单整体进度落后（完成比例 < 预期时间比例 × 0.7）
 *
 * 🟢 GREEN（正常）：
 *   - 以上条件都不满足
 */
export function computeOrderStatus(milestones: Milestone[]): OrderStatus {
  if (!milestones || milestones.length === 0) {
    return { color: 'GREEN', reason: '暂无执行节点', riskFactors: [] };
  }

  const now = new Date();
  const riskFactors: string[] = [];

  // 状态判断辅助 — 复用 lib/domain/types 的 canonical helpers，
  // 之前本地手写的列表（'卡住'/'卡单' 等）漏映射会导致状态判错。2026-05-19 收口。
  const _isDone = (s: string) => isDoneStatus(s);
  const _isBlocked = (s: string) => isBlockedStatus(s);
  const _isActive = (s: string) => isActiveStatus(s);
  const _isPending = (s: string) => isPendingStatus(s);

  // ===== 🔴 RED 条件 =====

  // 1. 阻塞节点
  const blockedMilestones = milestones.filter(m => _isBlocked(m.status));
  if (blockedMilestones.length > 0) {
    riskFactors.push(`${blockedMilestones.length}个节点阻塞：${blockedMilestones.map(m => m.name).join('、')}`);
  }

  // 2. 超期的进行中节点
  const inProgressMilestones = milestones.filter(m => _isActive(m.status));
  const overdueInProgress = inProgressMilestones.filter(m => {
    if (!m.due_at) return false;
    return isAfter(startOfDay(now), startOfDay(new Date(m.due_at)));
  });
  if (overdueInProgress.length > 0) {
    riskFactors.push(`${overdueInProgress.length}个节点已超期：${overdueInProgress.map(m => m.name).join('、')}`);
  }

  // 3. 实际日期严重偏差（>3天）
  const actualAtRedAlerts = milestones.filter(m =>
    !_isDone(m.status) && m.actual_at && computeDeliveryAlert(m.actual_at, m.due_at) === 'RED'
  );
  if (actualAtRedAlerts.length > 0) {
    riskFactors.push(`交期高风险：${actualAtRedAlerts.map(m => m.name).join('、')} 实际日期严重滞后`);
  }

  // 任意RED条件命中 → 返回RED
  if (blockedMilestones.length > 0 || overdueInProgress.length > 0 || actualAtRedAlerts.length > 0) {
    return {
      color: 'RED',
      reason: riskFactors[0],
      riskFactors,
    };
  }

  // ===== 🟡 YELLOW 条件（预判风险） =====
  const yellowFactors: string[] = [];

  // Y1. 进行中节点距到期≤72小时（3天窗口，足够干预）
  const urgentMilestones = inProgressMilestones.filter(m => {
    if (!m.due_at) return false;
    const hoursRemaining = differenceInHours(new Date(m.due_at), now);
    return hoursRemaining > 0 && hoursRemaining <= 72;
  });
  if (urgentMilestones.length > 0) {
    const details = urgentMilestones.map(m => {
      const hrs = differenceInHours(new Date(m.due_at!), now);
      return `${m.name}(${hrs < 24 ? hrs + 'h' : Math.ceil(hrs / 24) + '天'})`;
    });
    yellowFactors.push(`即将到期：${details.join('、')}`);
  }

  // Y2. 节点已过计划时间（进度偏差）
  const behindSchedule = inProgressMilestones.filter(m => {
    if (!m.planned_at || !m.due_at) return false;
    const plannedAt = new Date(m.planned_at);
    const dueAt = new Date(m.due_at);
    // 当前已过计划时间但还没到截止时间
    return isAfter(now, plannedAt) && isBefore(now, dueAt);
  });
  if (behindSchedule.length > 0) {
    yellowFactors.push(`进度偏差：${behindSchedule.map(m => m.name).join('、')} 已超计划时间`);
  }

  // Y3. 实际日期偏差1-3天（黄灯预警）
  const actualAtYellowAlerts = milestones.filter(m =>
    !_isDone(m.status) && m.actual_at && computeDeliveryAlert(m.actual_at, m.due_at) === 'YELLOW'
  );
  if (actualAtYellowAlerts.length > 0) {
    yellowFactors.push(`交期偏差：${actualAtYellowAlerts.map(m => m.name).join('、')} 实际日期轻度滞后`);
  }

  // Y4. 进行中节点无负责人（无人认领 = 管理盲区）
  const unassigned = inProgressMilestones.filter(m => !(m as any).owner_user_id);
  if (unassigned.length > 0) {
    yellowFactors.push(`无人认领：${unassigned.map(m => m.name).join('、')}`);
  }

  // Y5. 需要凭证但距到期≤5天未上传（提前预警）
  // 由于凭证状态需要额外查询，这里用简化逻辑：evidence_required=true + 距到期≤5天
  const evidenceRisk = inProgressMilestones.filter(m => {
    if (!(m as any).evidence_required || !m.due_at) return false;
    const daysRemaining = differenceInCalendarDays(new Date(m.due_at), now);
    return daysRemaining >= 0 && daysRemaining <= 5;
  });
  if (evidenceRisk.length > 0) {
    yellowFactors.push(`凭证待上传：${evidenceRisk.map(m => m.name).join('、')} 即将到期`);
  }

  // Y6. 订单整体进度落后
  // 计算：完成比例 vs 时间消耗比例
  const totalMs = milestones.length;
  const doneMs = milestones.filter(m => _isDone(m.status)).length;
  const completionRatio = doneMs / totalMs;

  // 用最早和最晚的 due_at 来估算时间进度
  const dueDates = milestones.filter(m => m.due_at).map(m => new Date(m.due_at!).getTime());
  if (dueDates.length >= 2) {
    const earliest = Math.min(...dueDates);
    const latest = Math.max(...dueDates);
    const totalSpan = latest - earliest;
    if (totalSpan > 0) {
      const elapsed = now.getTime() - earliest;
      const timeRatio = Math.max(0, Math.min(1, elapsed / totalSpan));
      // 如果时间过了60%但完成度<40%，进度严重落后
      if (timeRatio > 0.6 && completionRatio < timeRatio * 0.65) {
        const pctDone = Math.round(completionRatio * 100);
        const pctTime = Math.round(timeRatio * 100);
        yellowFactors.push(`整体进度落后：已完成${pctDone}% 但时间已过${pctTime}%`);
      }
    }
  }

  // Y7. 未开始但距到期≤5天的节点（还没启动就快到期了）
  const pendingUrgent = milestones.filter(m => {
    if (!_isPending(m.status) || !m.due_at) return false;
    const daysRemaining = differenceInCalendarDays(new Date(m.due_at), now);
    return daysRemaining >= 0 && daysRemaining <= 5;
  });
  if (pendingUrgent.length > 0) {
    yellowFactors.push(`未启动但即将到期：${pendingUrgent.map(m => m.name).join('、')}`);
  }

  if (yellowFactors.length > 0) {
    return {
      color: 'YELLOW',
      reason: yellowFactors[0],
      riskFactors: yellowFactors,
    };
  }

  // ===== 🟢 GREEN =====
  return { color: 'GREEN', reason: '所有节点正常推进', riskFactors: [] };
}
