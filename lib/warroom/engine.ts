/**
 * CEO War Room Engine V1.2
 * 根因分析 + 行动建议引擎（纯确定性规则）
 */

import { isDoneStatus, isBlockedStatus } from '@/lib/domain/types';

export type RiskLevel = 'CRITICAL' | 'HIGH' | 'MEDIUM';

export type RootCauseType =
  | 'chain_delay'
  | 'role_bottleneck'
  | 'no_owner'
  | 'blocked_critical'
  | 'etd_at_risk'
  | 'overdue_cascade';

export type ActionType =
  | 'assign_owner'
  | 'escalate'
  | 'notify_client'
  | 'prioritize'
  | 'expedite_material'
  | 'push_booking'
  | 'internal_meeting';

export interface RootCause {
  type: RootCauseType;
  description: string;
  affectedNodes: string[];
  severity: 1 | 2 | 3;
}

export interface SuggestedAction {
  type: ActionType;
  label: string;
  description: string;
  urgency: 'immediate' | 'today' | 'this_week';
  targetRole?: string;
}

export interface OrderWarRoomAnalysis {
  orderId: string;
  orderNo: string;
  customerName: string;
  etd: string | null;
  daysToEtd: number | null;
  riskLevel: RiskLevel;
  riskScore: number;
  overdueCount: number;
  blockedCount: number;
  unownedCriticalCount: number;
  rootCauses: RootCause[];
  suggestedActions: SuggestedAction[];
  warRoomSummary: string;
}

const ROLE_LABEL: Record<string, string> = {
  sales: '业务', finance: '财务', procurement: '采购',
  production: '生产', qc: '质检', logistics: '物流/仓库',
};

function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null;
  return Math.round((new Date(dateStr).getTime() - Date.now()) / 86400000);
}

export function analyzeOrder(order: any, milestones: any[]): OrderWarRoomAnalysis {
  const now = Date.now();

  const overdue = milestones.filter(m =>
    !isDoneStatus(m.status) && m.due_at && new Date(m.due_at).getTime() < now
  );
  const blocked = milestones.filter(m => isBlockedStatus(m.status));
  const unownedCritical = milestones.filter(m =>
    m.is_critical && !m.owner_user_id && !isDoneStatus(m.status)
  );
  const daysToEtd = daysUntil(order.etd || order.warehouse_due_date);

  const rootCauses: RootCause[] = [];

  // 1. 连锁延期
  if (overdue.length >= 3) {
    const sorted = [...overdue].sort((a, b) =>
      new Date(a.due_at).getTime() - new Date(b.due_at).getTime()
    );
    rootCauses.push({
      type: 'chain_delay',
      description: overdue.length + ' 个节点依次逾期，形成连锁延误，最早逾期：「' + sorted[0]?.name + '」',
      affectedNodes: sorted.map((m: any) => m.step_key),
      severity: overdue.length >= 6 ? 1 : 2,
    });
  }

  // 2. 角色瓶颈
  const roleCount: Record<string, string[]> = {};
  [...overdue, ...blocked].forEach((m: any) => {
    const role = m.owner_role || 'unassigned';
    if (!roleCount[role]) roleCount[role] = [];
    if (!roleCount[role].includes(m.name)) roleCount[role].push(m.name);
  });
  Object.entries(roleCount).forEach(([role, names]) => {
    if (names.length >= 2) {
      rootCauses.push({
        type: 'role_bottleneck',
        description: (ROLE_LABEL[role] || role) + ' 部门积压 ' + names.length + ' 个逾期/阻塞节点',
        affectedNodes: names,
        severity: 2,
      });
    }
  });

  // 3. 无执行人
  if (unownedCritical.length > 0) {
    rootCauses.push({
      type: 'no_owner',
      description: unownedCritical.length + ' 个关键节点未分配执行人，风险无人负责',
      affectedNodes: unownedCritical.map((m: any) => m.step_key),
      severity: 2,
    });
  }

  // 4. 关键节点阻塞
  const criticalBlocked = blocked.filter((m: any) => m.is_critical);
  if (criticalBlocked.length > 0) {
    rootCauses.push({
      type: 'blocked_critical',
      description: criticalBlocked.length + ' 个关键节点阻塞：' + criticalBlocked.map((m: any) => m.name).join('、'),
      affectedNodes: criticalBlocked.map((m: any) => m.step_key),
      severity: 1,
    });
  }

  // 5. ETD 风险
  if (daysToEtd !== null && daysToEtd <= 14 && daysToEtd >= 0) {
    const incompleteCritical = milestones.filter((m: any) => m.is_critical && !isDoneStatus(m.status)).length;
    if (incompleteCritical > 0) {
      rootCauses.push({
        type: 'etd_at_risk',
        description: '距 ETD 仅剩 ' + daysToEtd + ' 天，仍有 ' + incompleteCritical + ' 个关键节点未完成',
        affectedNodes: [],
        severity: daysToEtd <= 7 ? 1 : 2,
      });
    }
  }

  // 风险评分
  let riskScore = 0;
  riskScore += Math.min(overdue.length * 8, 40);
  riskScore += Math.min(blocked.length * 15, 30);
  riskScore += unownedCritical.length * 5;
  if (daysToEtd !== null) {
    if (daysToEtd < 0) riskScore += 30;
    else if (daysToEtd <= 7) riskScore += 20;
    else if (daysToEtd <= 14) riskScore += 10;
  }
  riskScore = Math.min(riskScore, 100);

  const riskLevel: RiskLevel =
    riskScore >= 70 ? 'CRITICAL' : riskScore >= 40 ? 'HIGH' : 'MEDIUM';

  // 行动建议
  const suggestedActions: SuggestedAction[] = [];

  if (unownedCritical.length > 0) {
    suggestedActions.push({
      type: 'assign_owner', label: '指派执行人',
      description: '立即为 ' + unownedCritical.length + ' 个无主关键节点指派负责人',
      urgency: 'immediate',
    });
  }

  if (criticalBlocked.length > 0) {
    suggestedActions.push({
      type: 'escalate', label: '升级处理',
      description: '「' + criticalBlocked[0]?.name + '」等关键节点阻塞，需管理层介入解除',
      urgency: 'immediate',
    });
  }

  if (daysToEtd !== null && daysToEtd <= 7 && daysToEtd >= 0) {
    suggestedActions.push({
      type: 'notify_client', label: '主动通知客户',
      description: '距 ETD 仅 ' + daysToEtd + ' 天，建议向客户同步出货风险',
      urgency: 'immediate',
    });
    suggestedActions.push({
      type: 'push_booking', label: '催订舱',
      description: '立即确认订舱状态，避免错过船期',
      urgency: 'immediate',
    });
  }

  const procOverdue = overdue.filter((m: any) =>
    m.owner_role === 'procurement' || (m.step_key || '').includes('material')
  );
  if (procOverdue.length > 0) {
    suggestedActions.push({
      type: 'expedite_material', label: '紧急催料',
      description: '采购/物料环节 ' + procOverdue.length + ' 个节点逾期，需跟进供应商',
      urgency: 'today', targetRole: 'procurement',
    });
  }

  if (rootCauses.some(r => r.type === 'role_bottleneck')) {
    suggestedActions.push({
      type: 'internal_meeting', label: '召开协调会',
      description: '多部门出现节点积压，建议今日内召开15分钟跨部门对齐会',
      urgency: 'today',
    });
  }

  if (riskLevel === 'CRITICAL') {
    suggestedActions.push({
      type: 'prioritize', label: '调整生产优先级',
      description: '将此订单列入最高优先级，协调工厂资源集中处理',
      urgency: 'today', targetRole: 'production',
    });
  }

  const summary =
    riskLevel === 'CRITICAL'
      ? (rootCauses[0]
          ? '⚠️ 高危：' + rootCauses[0].description
          : '⚠️ 高危订单，' + overdue.length + ' 个节点逾期')
      : riskLevel === 'HIGH'
      ? '🔶 风险较高：' + overdue.length + ' 个逾期节点，距 ETD ' + (daysToEtd ?? '未知') + ' 天'
      : '🟡 需关注：' + overdue.length + ' 个节点逾期';

  return {
    orderId: order.id,
    orderNo: order.order_no,
    customerName: order.customer_name,
    etd: order.etd || order.warehouse_due_date || null,
    daysToEtd,
    riskLevel,
    riskScore,
    overdueCount: overdue.length,
    blockedCount: blocked.length,
    unownedCriticalCount: unownedCritical.length,
    rootCauses: rootCauses.sort((a, b) => a.severity - b.severity),
    suggestedActions: suggestedActions.slice(0, 5),
    warRoomSummary: summary,
  };
}

export function getTopCriticalOrders(
  ordersWithMilestones: Array<{ order: any; milestones: any[] }>,
  topN = 3
): OrderWarRoomAnalysis[] {
  return ordersWithMilestones
    .map(({ order, milestones }) => analyzeOrder(order, milestones))
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, topN);
}
