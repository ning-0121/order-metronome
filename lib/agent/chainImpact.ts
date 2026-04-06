/**
 * 链路影响分析 — 上下游预警引擎
 *
 * 核心逻辑：
 * 1. 当一个节点即将到期/已逾期，计算对所有下游节点的影响
 * 2. 提前通知下游负责人准备
 * 3. 通知上游负责人：你的延迟影响了谁
 */

interface MilestoneForChain {
  id: string;
  step_key: string;
  name: string;
  status: string;
  due_at: string | null;
  actual_at: string | null;
  owner_user_id: string | null;
  owner_role: string | null;
  sort_order: number; // 在模板中的顺序
}

export interface ChainAlert {
  type: 'upstream_warning' | 'downstream_prepare' | 'delay_propagation' | 'deadline_risk';
  targetUserId: string | null;
  targetRole: string | null;
  sourceMilestoneId: string;
  sourceMilestoneName: string;
  affectedMilestoneId: string;
  affectedMilestoneName: string;
  title: string;
  message: string;
  severity: 'high' | 'medium' | 'low';
  daysUntilDue: number;
  estimatedDelayDays: number;
}

/**
 * 分析整条链路，生成上下游预警
 */
export function analyzeChainImpact(
  milestones: MilestoneForChain[],
  orderNo: string,
  anchorDate?: string | null, // ETD/工厂交期
): ChainAlert[] {
  const alerts: ChainAlert[] = [];
  const now = new Date();
  const sorted = [...milestones].sort((a, b) => a.sort_order - b.sort_order);

  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i];
    if (!current.due_at) continue;

    const dueDate = new Date(current.due_at);
    const daysUntilDue = Math.ceil((dueDate.getTime() - now.getTime()) / 86400000);
    const isDone = current.status === '已完成' || current.status === 'done' || current.status === 'completed';
    const isActive = current.status === '进行中' || current.status === 'in_progress';

    if (isDone) continue;

    // ═══ T-5天：通知下一个节点负责人准备 ═══
    if (daysUntilDue <= 5 && daysUntilDue > 3 && isActive) {
      const next = findNextUndone(sorted, i);
      if (next && next.owner_user_id && next.owner_user_id !== current.owner_user_id) {
        alerts.push({
          type: 'downstream_prepare',
          targetUserId: next.owner_user_id,
          targetRole: next.owner_role,
          sourceMilestoneId: current.id,
          sourceMilestoneName: current.name,
          affectedMilestoneId: next.id,
          affectedMilestoneName: next.name,
          title: `📢 请提前准备「${next.name}」`,
          message: `${orderNo}：「${current.name}」预计 ${daysUntilDue} 天后完成，请提前准备「${next.name}」的工作`,
          severity: 'low',
          daysUntilDue,
          estimatedDelayDays: 0,
        });
      }
    }

    // ═══ T-3天：通知当前+下游2个节点 ═══
    if (daysUntilDue <= 3 && daysUntilDue > 0 && !isDone) {
      // 通知下游2个节点的负责人
      const downstream = findDownstreamUndone(sorted, i, 2);
      for (const ds of downstream) {
        if (ds.owner_user_id && ds.owner_user_id !== current.owner_user_id) {
          alerts.push({
            type: 'downstream_prepare',
            targetUserId: ds.owner_user_id,
            targetRole: ds.owner_role,
            sourceMilestoneId: current.id,
            sourceMilestoneName: current.name,
            affectedMilestoneId: ds.id,
            affectedMilestoneName: ds.name,
            title: `⚠️「${current.name}」还有 ${daysUntilDue} 天到期`,
            message: `${orderNo}：「${current.name}」${daysUntilDue}天后到期，你负责的「${ds.name}」请做好准备。如上游延迟，你会提前收到通知`,
            severity: 'medium',
            daysUntilDue,
            estimatedDelayDays: 0,
          });
        }
      }

      // 给当前负责人：你的延迟会影响谁
      if (current.owner_user_id) {
        const impactNames = downstream.map(d => d.name).join('、');
        if (impactNames) {
          alerts.push({
            type: 'upstream_warning',
            targetUserId: current.owner_user_id,
            targetRole: current.owner_role,
            sourceMilestoneId: current.id,
            sourceMilestoneName: current.name,
            affectedMilestoneId: current.id,
            affectedMilestoneName: current.name,
            title: `⏰「${current.name}」还有 ${daysUntilDue} 天`,
            message: `${orderNo}：如未按时完成，将影响后续节点：${impactNames}`,
            severity: daysUntilDue <= 1 ? 'high' : 'medium',
            daysUntilDue,
            estimatedDelayDays: 0,
          });
        }
      }
    }

    // ═══ 已逾期：计算延迟传播 ═══
    if (daysUntilDue < 0) {
      const delayDays = Math.abs(daysUntilDue);
      const downstream = findDownstreamUndone(sorted, i, 5);

      for (const ds of downstream) {
        if (!ds.owner_user_id) continue;

        alerts.push({
          type: 'delay_propagation',
          targetUserId: ds.owner_user_id,
          targetRole: ds.owner_role,
          sourceMilestoneId: current.id,
          sourceMilestoneName: current.name,
          affectedMilestoneId: ds.id,
          affectedMilestoneName: ds.name,
          title: `🔴 上游「${current.name}」已逾期 ${delayDays} 天`,
          message: `${orderNo}：「${current.name}」逾期${delayDays}天，你负责的「${ds.name}」预计延后${delayDays}天。如需调整排期请联系管理员`,
          severity: delayDays >= 3 ? 'high' : 'medium',
          daysUntilDue,
          estimatedDelayDays: delayDays,
        });
      }

      // 检查是否影响最终交期
      if (anchorDate) {
        const anchor = new Date(anchorDate);
        const lastMilestone = sorted[sorted.length - 1];
        if (lastMilestone.due_at) {
          const lastDue = new Date(lastMilestone.due_at);
          const projectedEnd = new Date(lastDue.getTime() + delayDays * 86400000);
          if (projectedEnd > anchor) {
            const overDays = Math.ceil((projectedEnd.getTime() - anchor.getTime()) / 86400000);
            alerts.push({
              type: 'deadline_risk',
              targetUserId: null, // 通知管理员
              targetRole: 'admin',
              sourceMilestoneId: current.id,
              sourceMilestoneName: current.name,
              affectedMilestoneId: lastMilestone.id,
              affectedMilestoneName: '最终交期',
              title: `🚨 ${orderNo} 交期可能延误 ${overDays} 天`,
              message: `「${current.name}」逾期${delayDays}天，按当前进度交期将超出${overDays}天。建议立即协调资源或申请延期`,
              severity: 'high',
              daysUntilDue: 0,
              estimatedDelayDays: overDays,
            });
          }
        }
      }
    }
  }

  // 去重：同一个目标用户+同一个来源节点只保留最高优先级的
  const seen = new Set<string>();
  return alerts.filter(a => {
    const key = `${a.targetUserId}:${a.sourceMilestoneId}:${a.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 找下一个未完成的节点
 */
function findNextUndone(sorted: MilestoneForChain[], fromIndex: number): MilestoneForChain | null {
  for (let j = fromIndex + 1; j < sorted.length; j++) {
    const m = sorted[j];
    if (m.status !== '已完成' && m.status !== 'done' && m.status !== 'completed') {
      return m;
    }
  }
  return null;
}

/**
 * 找下游N个未完成的节点
 */
function findDownstreamUndone(sorted: MilestoneForChain[], fromIndex: number, count: number): MilestoneForChain[] {
  const result: MilestoneForChain[] = [];
  for (let j = fromIndex + 1; j < sorted.length && result.length < count; j++) {
    const m = sorted[j];
    if (m.status !== '已完成' && m.status !== 'done' && m.status !== 'completed') {
      result.push(m);
    }
  }
  return result;
}
