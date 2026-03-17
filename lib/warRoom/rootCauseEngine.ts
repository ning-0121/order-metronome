/**
 * Root Cause Analysis Engine — V1.2 War Room
 * 纯规则引擎，无 LLM，确定性逻辑
 */

export type RiskLevel = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface MilestoneData {
  id: string;
  step_key: string;
  name: string;
  owner_role: string;
  owner_user_id: string | null;
  due_at: string | null;
  status: string;
  is_critical: boolean;
  sequence_number: number;
}

export interface OrderData {
  id: string;
  order_no: string;
  customer_name: string;
  incoterm: string;
  etd: string | null;
  eta: string | null;
  warehouse_due_date: string | null;
  cancel_date: string | null;
  order_type: string;
  milestones: MilestoneData[];
}

export interface RootCause {
  code: string;
  label: string;
  detail: string;
  affectedRoles: string[];
  affectedMilestones: string[];
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM';
}

export interface WarRoomOrder {
  order: OrderData;
  riskLevel: RiskLevel;
  riskScore: number;
  overdueCount: number;
  blockedCount: number;
  unassignedCriticalCount: number;
  daysToAnchor: number | null;
  rootCauses: RootCause[];
  chainDelayDetected: boolean;
  bottleneckRoles: string[];
}

const ROLE_LABELS: Record<string, string> = {
  sales: '业务', finance: '财务', procurement: '采购',
  production: '生产', qc: '质检', logistics: '物流/仓库', admin: '管理员',
};

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function isOverdue(due_at: string | null): boolean {
  if (!due_at) return false;
  return new Date(due_at) < new Date();
}

function getDaysOverdue(due_at: string | null): number {
  if (!due_at) return 0;
  const d = daysBetween(new Date(due_at), new Date());
  return Math.max(0, d);
}

/** 计算单订单风险分 */
function calcRiskScore(order: OrderData, now: Date): {
  score: number;
  overdueCount: number;
  blockedCount: number;
  unassignedCritical: number;
  daysToAnchor: number | null;
} {
  const milestones = order.milestones || [];
  let score = 0;
  let overdueCount = 0;
  let blockedCount = 0;
  let unassignedCritical = 0;

  // 锚点日期（ETD / ETA / 仓库截止）
  const anchorStr = order.etd || order.eta || order.warehouse_due_date;
  const anchor = anchorStr ? new Date(anchorStr) : null;
  const daysToAnchor = anchor ? daysBetween(now, anchor) : null;

  // 锚点紧迫度
  if (daysToAnchor !== null) {
    if (daysToAnchor < 0)  score += 80;  // 已过锚点
    else if (daysToAnchor <= 3)  score += 60;
    else if (daysToAnchor <= 7)  score += 40;
    else if (daysToAnchor <= 14) score += 20;
  }

  // Cancel Date 紧迫度
  if (order.cancel_date) {
    const cancelDays = daysBetween(now, new Date(order.cancel_date));
    if (cancelDays < 0)  score += 30;
    else if (cancelDays <= 3) score += 20;
    else if (cancelDays <= 7) score += 10;
  }

  for (const m of milestones) {
    const done = m.status === '已完成';
    const blocked = m.status === '阻塞';
    const overdue = !done && isOverdue(m.due_at);
    const daysOver = getDaysOverdue(m.due_at);

    if (overdue) {
      overdueCount++;
      score += m.is_critical ? Math.min(daysOver * 3, 30) : Math.min(daysOver, 10);
    }
    if (blocked) {
      blockedCount++;
      score += m.is_critical ? 25 : 10;
    }
    if (!done && m.is_critical && !m.owner_user_id) {
      unassignedCritical++;
      score += 15;
    }
  }

  return { score, overdueCount, blockedCount, unassignedCritical, daysToAnchor };
}

/** 根因分析 */
function analyzeRootCauses(order: OrderData, now: Date): RootCause[] {
  const milestones = order.milestones || [];
  const causes: RootCause[] = [];

  // 1. 无负责人的关键节点
  const unassignedCritical = milestones.filter(
    m => m.is_critical && !m.owner_user_id && m.status !== '已完成'
  );
  if (unassignedCritical.length > 0) {
    causes.push({
      code: 'UNASSIGNED_CRITICAL',
      label: '关键节点无负责人',
      detail: `${unassignedCritical.length} 个关键节点尚未指定执行人，无法追责`,
      affectedRoles: [...new Set(unassignedCritical.map(m => ROLE_LABELS[m.owner_role] || m.owner_role))],
      affectedMilestones: unassignedCritical.map(m => m.name),
      severity: 'CRITICAL',
    });
  }

  // 2. 链式延误（连续 3+ 个节点逾期）
  const sorted = [...milestones].sort((a, b) => a.sequence_number - b.sequence_number);
  let chainLen = 0;
  let chainStart = -1;
  let maxChain = 0;
  let maxChainStart = -1;
  for (let i = 0; i < sorted.length; i++) {
    const m = sorted[i];
    if (m.status !== '已完成' && isOverdue(m.due_at)) {
      if (chainLen === 0) chainStart = i;
      chainLen++;
      if (chainLen > maxChain) { maxChain = chainLen; maxChainStart = chainStart; }
    } else {
      chainLen = 0;
    }
  }
  if (maxChain >= 3) {
    const chainMs = sorted.slice(maxChainStart, maxChainStart + maxChain);
    causes.push({
      code: 'CHAIN_DELAY',
      label: '链式延误',
      detail: `连续 ${maxChain} 个节点逾期，从「${chainMs[0]?.name}」到「${chainMs[maxChain-1]?.name}」`,
      affectedRoles: [...new Set(chainMs.map(m => ROLE_LABELS[m.owner_role] || m.owner_role))],
      affectedMilestones: chainMs.map(m => m.name),
      severity: 'HIGH',
    });
  }

  // 3. 角色瓶颈（同一角色 2+ 个逾期）
  const roleOverdue: Record<string, string[]> = {};
  for (const m of milestones) {
    if (m.status !== '已完成' && isOverdue(m.due_at)) {
      const role = ROLE_LABELS[m.owner_role] || m.owner_role;
      if (!roleOverdue[role]) roleOverdue[role] = [];
      roleOverdue[role].push(m.name);
    }
  }
  for (const [role, names] of Object.entries(roleOverdue)) {
    if (names.length >= 2) {
      causes.push({
        code: 'ROLE_BOTTLENECK',
        label: `${role}部门瓶颈`,
        detail: `${role}部门有 ${names.length} 个节点逾期，疑似资源不足或执行卡位`,
        affectedRoles: [role],
        affectedMilestones: names,
        severity: names.length >= 4 ? 'CRITICAL' : 'HIGH',
      });
    }
  }

  // 4. 阻塞节点
  const blockedMs = milestones.filter(m => m.status === '阻塞');
  if (blockedMs.length > 0) {
    causes.push({
      code: 'BLOCKED_NODES',
      label: '节点被阻塞',
      detail: `${blockedMs.length} 个节点处于阻塞状态，需要介入解决`,
      affectedRoles: [...new Set(blockedMs.map(m => ROLE_LABELS[m.owner_role] || m.owner_role))],
      affectedMilestones: blockedMs.map(m => m.name),
      severity: blockedMs.some(m => m.is_critical) ? 'CRITICAL' : 'HIGH',
    });
  }

  // 5. 锚点临近但前置未完成
  const anchorStr = order.etd || order.eta || order.warehouse_due_date;
  if (anchorStr) {
    const daysToAnchor = daysBetween(new Date(), new Date(anchorStr));
    const incompleteCount = milestones.filter(m => m.status !== '已完成').length;
    if (daysToAnchor <= 7 && incompleteCount >= 5) {
      causes.push({
        code: 'ANCHOR_RISK',
        label: '出货日临近，节点严重滞后',
        detail: `距出货日仅剩 ${Math.max(0, daysToAnchor)} 天，仍有 ${incompleteCount} 个节点未完成`,
        affectedRoles: [],
        affectedMilestones: [],
        severity: 'CRITICAL',
      });
    }
  }

  // 按严重程度排序
  const severityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2 };
  return causes.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
}

/** 主入口：分析所有订单，返回 War Room 数据 */
export function analyzeWarRoom(orders: OrderData[]): WarRoomOrder[] {
  const now = new Date();

  const results: WarRoomOrder[] = orders.map(order => {
    const { score, overdueCount, blockedCount, unassignedCritical, daysToAnchor } =
      calcRiskScore(order, now);

    const rootCauses = analyzeRootCauses(order, now);
    const chainDelayDetected = rootCauses.some(c => c.code === 'CHAIN_DELAY');

    // 瓶颈角色
    const bottleneckRoles = rootCauses
      .filter(c => c.code === 'ROLE_BOTTLENECK')
      .flatMap(c => c.affectedRoles);

    // 风险级别
    let riskLevel: RiskLevel = 'LOW';
    if (score >= 80 || rootCauses.some(c => c.severity === 'CRITICAL')) riskLevel = 'CRITICAL';
    else if (score >= 50 || rootCauses.some(c => c.severity === 'HIGH')) riskLevel = 'HIGH';
    else if (score >= 25) riskLevel = 'MEDIUM';

    return {
      order,
      riskLevel,
      riskScore: score,
      overdueCount,
      blockedCount,
      unassignedCriticalCount: unassignedCritical,
      daysToAnchor,
      rootCauses,
      chainDelayDetected,
      bottleneckRoles,
    };
  });

  // 按风险分降序
  return results.sort((a, b) => b.riskScore - a.riskScore);
}
