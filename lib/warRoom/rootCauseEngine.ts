/**
 * Root Cause Analysis Engine — V1.2.1 (Refined)
 *
 * 设计原则：
 * - 风险评分严格加权，避免过度告警
 * - 链式延误只报根因节点，不列出所有下游
 * - CRITICAL 门槛大幅提高（只有真正危急才触发）
 * - 无负责人不单独算 CRITICAL，只是加分项
 */

import { isDoneStatus, isBlockedStatus } from '@/lib/domain/types';

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
  /** 压缩后的受影响阶段（不列所有节点） */
  impactedStages: string[];
  /** 根因节点（链式延误的起点） */
  rootNode?: string;
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
  chainDelay?: { rootNode: string; chainLen: number; impactedStages: string[] };
  bottleneckRoles: string[];
}

const ROLE_LABELS: Record<string, string> = {
  sales: '业务', finance: '财务', procurement: '采购',
  production: '生产', qc: '质检', logistics: '物流', admin: '管理员',
};

// 阶段映射（step_key → 阶段名）
const STAGE_MAP: Record<string, string> = {
  po_confirmed: '订单启动', finance_approval: '订单启动',
  order_kickoff_meeting: '订单启动', production_resources_confirmed: '订单启动',
  order_docs_bom_complete: '订单转化', bulk_materials_confirmed: '订单转化',
  pre_production_sample_ready: '产前样', pre_production_sample_sent: '产前样',
  pre_production_sample_approved: '产前样',
  procurement_order_placed: '采购备料', materials_received_inspected: '采购备料',
  production_kickoff: '生产', pre_production_meeting: '生产',
  mid_qc_check: '过程控制', final_qc_check: '过程控制',
  packing_method_confirmed: '出货控制', inspection_release: '出货控制',
  shipping_sample_send: '出货控制',
  booking_done: '物流', customs_export: '物流', payment_received: '物流',
};

function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86400000);
}

function isOverdue(due_at: string | null): boolean {
  if (!due_at) return false;
  return new Date(due_at) < new Date();
}

function getDaysOverdue(due_at: string | null): number {
  if (!due_at) return 0;
  return Math.max(0, daysBetween(new Date(due_at), new Date()));
}

/**
 * 严格加权评分
 *
 * 权重设计：
 * - ETD 临近是最重要的单一因子
 * - 关键节点逾期 > 普通节点逾期
 * - 逾期天数有上限（避免久逾历史订单刷屏）
 * - 阻塞节点 > 逾期节点（主动上报的问题更紧急）
 */
function calcRiskScore(order: OrderData): {
  score: number;
  overdueCount: number;
  blockedCount: number;
  unassignedCritical: number;
  daysToAnchor: number | null;
} {
  const milestones = order.milestones || [];
  const now = new Date();
  let score = 0;
  let overdueCount = 0;
  let blockedCount = 0;
  let unassignedCritical = 0;

  const anchorStr = order.etd || order.eta || order.warehouse_due_date;
  const anchor = anchorStr ? new Date(anchorStr) : null;
  const daysToAnchor = anchor ? daysBetween(now, anchor) : null;

  // ── A. ETD 临近权重（最重要，占分最多）──
  if (daysToAnchor !== null) {
    if (daysToAnchor < 0)      score += 60;  // 已过 ETD
    else if (daysToAnchor <= 3) score += 45;
    else if (daysToAnchor <= 7) score += 30;
    else if (daysToAnchor <= 14) score += 15;
    else if (daysToAnchor <= 21) score += 5;
    // > 21 天：ETD 不是当前压力，不加分
  }

  // ── B. Cancel Date 紧迫 ──
  if (order.cancel_date) {
    const cancelDays = daysBetween(now, new Date(order.cancel_date));
    if (cancelDays < 0)      score += 20;
    else if (cancelDays <= 3) score += 15;
    else if (cancelDays <= 7) score += 8;
  }

  // ── C. 节点级评分（只计 未完成 的节点）──
  let criticalOverdueCount = 0;
  for (const m of milestones) {
    const done = isDoneStatus(m.status);
    if (done) continue;

    const blocked = isBlockedStatus(m.status);
    const overdue = isOverdue(m.due_at);
    const daysOver = getDaysOverdue(m.due_at);

    if (blocked) {
      blockedCount++;
      // 阻塞：关键节点 15分，普通 5分（上限）
      score += m.is_critical ? 15 : 5;
    } else if (overdue) {
      overdueCount++;
      if (m.is_critical) {
        criticalOverdueCount++;
        // 关键节点逾期：前5天每天4分，之后递减，最多20分
        score += Math.min(20, daysOver <= 5 ? daysOver * 4 : 20 + Math.min(5, (daysOver - 5)));
      } else {
        // 普通节点：最多5分
        score += Math.min(5, daysOver);
      }
    }

    if (m.is_critical && !m.owner_user_id) {
      unassignedCritical++;
      score += 3; // 无负责人：小幅加分，不作为主要风险因子
    }
  }

  return { score, overdueCount, blockedCount, unassignedCritical, daysToAnchor };
}

/**
 * 链式延误分析 — 只找根因，压缩输出
 *
 * 算法：
 * 1. 按 sequence_number 排序
 * 2. 找最长连续逾期序列
 * 3. 只报序列中第一个未完成节点（根因）
 * 4. 将整条链压缩为受影响阶段列表
 */
function detectChainDelay(milestones: MilestoneData[]): {
  rootNode: string;
  chainLen: number;
  impactedStages: string[];
} | null {
  const active = milestones
    .filter(m => !isDoneStatus(m.status))
    .sort((a, b) => a.sequence_number - b.sequence_number);

  let bestChain: MilestoneData[] = [];
  let current: MilestoneData[] = [];

  for (const m of active) {
    if (isOverdue(m.due_at)) {
      current.push(m);
      if (current.length > bestChain.length) bestChain = [...current];
    } else {
      current = [];
    }
  }

  // 链式延误门槛提高：至少4个节点才算（避免偶发2-3个节点误报）
  if (bestChain.length < 4) return null;

  const rootNode = bestChain[0].name;
  const stages = [...new Set(bestChain.map(m => STAGE_MAP[m.step_key] || '执行中'))];

  return { rootNode, chainLen: bestChain.length, impactedStages: stages };
}

/** 根因分析（精简版，避免重复告警）*/
function analyzeRootCauses(order: OrderData): RootCause[] {
  const milestones = order.milestones || [];
  const causes: RootCause[] = [];
  const reported = new Set<string>(); // 防止重复

  // ── 1. 链式延误（优先，压缩报告）──
  const chain = detectChainDelay(milestones);
  if (chain) {
    reported.add('CHAIN');
    causes.push({
      code: 'CHAIN_DELAY',
      label: '链式延误',
      detail: `从「${chain.rootNode}」开始，连续 ${chain.chainLen} 个节点逾期`,
      rootNode: chain.rootNode,
      impactedStages: chain.impactedStages,
      severity: chain.chainLen >= 6 ? 'CRITICAL' : 'HIGH',
    });
  }

  // ── 2. 阻塞节点（只报最严重的1个）──
  const blocked = milestones
    .filter(m => isBlockedStatus(m.status))
    .sort((a, b) => (b.is_critical ? 1 : 0) - (a.is_critical ? 1 : 0));
  if (blocked.length > 0 && !reported.has('BLOCKED')) {
    const top = blocked[0];
    const stages = [...new Set(blocked.map(m => STAGE_MAP[m.step_key] || '执行中'))];
    causes.push({
      code: 'BLOCKED',
      label: `节点阻塞（${blocked.length} 个）`,
      detail: `「${top.name}」等 ${blocked.length} 个节点被阻塞，需介入解决`,
      impactedStages: stages,
      severity: top.is_critical ? 'CRITICAL' : 'HIGH',
    });
  }

  // ── 3. 单一角色瓶颈（≥3个逾期才报）──
  if (!reported.has('CHAIN')) { // 链式延误已涵盖角色问题，不重复
    const roleOverdue: Record<string, number> = {};
    for (const m of milestones) {
      if (!isDoneStatus(m.status) && isOverdue(m.due_at)) {
        const r = ROLE_LABELS[m.owner_role] || m.owner_role;
        roleOverdue[r] = (roleOverdue[r] || 0) + 1;
      }
    }
    const bottlenecks = Object.entries(roleOverdue)
      .filter(([, n]) => n >= 3)
      .sort((a, b) => b[1] - a[1]);
    if (bottlenecks.length > 0) {
      const [role, count] = bottlenecks[0];
      causes.push({
        code: 'ROLE_BOTTLENECK',
        label: `${role}瓶颈`,
        detail: `${role}部门 ${count} 个节点逾期，执行能力不足或资源卡位`,
        impactedStages: [role],
        severity: count >= 5 ? 'HIGH' : 'MEDIUM',
      });
    }
  }

  // ── 4. ETD 临近但关键节点大量未完成（结构性风险）──
  const anchorStr = order.etd || order.eta || order.warehouse_due_date;
  if (anchorStr) {
    const daysToAnchor = daysBetween(new Date(), new Date(anchorStr));
    const incompleteCritical = milestones.filter(
      m => m.is_critical && !isDoneStatus(m.status)
    ).length;
    if (daysToAnchor <= 14 && incompleteCritical >= 8) {
      causes.push({
        code: 'STRUCTURAL_RISK',
        label: '结构性出货风险',
        detail: `距出货日 ${Math.max(0, daysToAnchor)} 天，仍有 ${incompleteCritical} 个关键节点未完成`,
        impactedStages: ['出货控制', '物流'],
        severity: daysToAnchor <= 7 ? 'CRITICAL' : 'HIGH',
      });
    }
  }

  const order_ = { CRITICAL: 0, HIGH: 1, MEDIUM: 2 };
  return causes.sort((a, b) => order_[a.severity] - order_[b.severity]).slice(0, 3);
}

/** 主入口 */
export function analyzeWarRoom(orders: OrderData[]): WarRoomOrder[] {
  const results: WarRoomOrder[] = orders.map(order => {
    const { score, overdueCount, blockedCount, unassignedCritical, daysToAnchor } =
      calcRiskScore(order);

    const rootCauses = analyzeRootCauses(order);
    const chainResult = detectChainDelay(order.milestones || []);

    // 瓶颈角色
    const bottleneckRoles = rootCauses
      .filter(c => c.code === 'ROLE_BOTTLENECK')
      .map(c => c.label.replace('瓶颈', ''));

    // ── 严格风险级别 ──
    // CRITICAL：只有真正紧迫的情况
    // - ETD ≤ 7天 且 score ≥ 60，或
    // - 有阻塞的关键节点 且 ETD ≤ 14天，或
    // - 链式延误 ≥ 6 个节点 且 ETD ≤ 14天
    const hasCriticalCause = rootCauses.some(c => c.severity === 'CRITICAL');
    const etdSoon = daysToAnchor !== null && daysToAnchor <= 7;
    const etdNear = daysToAnchor !== null && daysToAnchor <= 14;

    let riskLevel: RiskLevel;
    if ((etdSoon && score >= 55) || (etdNear && hasCriticalCause && score >= 45)) {
      riskLevel = 'CRITICAL';
    } else if (score >= 50 || (etdNear && score >= 35)) {
      riskLevel = 'HIGH';
    } else if (score >= 25) {
      riskLevel = 'MEDIUM';
    } else {
      riskLevel = 'LOW';
    }

    return {
      order,
      riskLevel,
      riskScore: score,
      overdueCount,
      blockedCount,
      unassignedCriticalCount: unassignedCritical,
      daysToAnchor,
      rootCauses,
      chainDelay: chainResult || undefined,
      bottleneckRoles,
    };
  });

  return results
    .sort((a, b) => b.riskScore - a.riskScore)
    .filter(r => r.riskLevel !== 'LOW'); // War Room 只展示有实际风险的
}
