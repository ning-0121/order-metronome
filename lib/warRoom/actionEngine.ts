/**
 * Action Suggestion Engine — V1.2.1 (Refined)
 *
 * 设计原则：
 * - 每个订单最多 3 条建议：立即行动 / 恢复路径 / 预防措施
 * - 建议必须可执行，指向具体责任人和页面
 * - 不重复，不产生噪声
 */

import type { WarRoomOrder } from './rootCauseEngine';

export type ActionCategory = 'IMMEDIATE' | 'RECOVERY' | 'PREVENTION';

export interface SuggestedAction {
  id: string;
  category: ActionCategory;
  categoryLabel: string;
  icon: string;
  label: string;
  description: string;
  targetRole: string;
  orderId: string;
  orderNo: string;
  ctaLabel: string;
  ctaHref: string;
}

const ROLE_LABELS: Record<string, string> = {
  sales: '业务', finance: '财务', procurement: '采购',
  production: '生产', qc: '质检', logistics: '物流', admin: '管理员',
};

const CATEGORY_CONFIG: Record<ActionCategory, { label: string; icon: string; style: string }> = {
  IMMEDIATE: { label: '立即处理', icon: '🔴', style: 'text-red-400 bg-red-950 border-red-900' },
  RECOVERY:  { label: '恢复路径', icon: '🟡', style: 'text-yellow-400 bg-yellow-950 border-yellow-900' },
  PREVENTION:{ label: '预防措施', icon: '🟢', style: 'text-green-400 bg-green-950 border-green-900' },
};

export { CATEGORY_CONFIG };

let _id = 0;
const id = () => 'A' + (++_id);

/**
 * 每个订单生成最多3条建议：
 * - 1 条 IMMEDIATE（立即行动）
 * - 1 条 RECOVERY（恢复路径）
 * - 1 条 PREVENTION（预防措施，可选）
 */
function buildActionsForOrder(wr: WarRoomOrder): SuggestedAction[] {
  const actions: SuggestedAction[] = [];
  const { order, rootCauses, riskLevel, daysToAnchor,
          blockedCount, unassignedCriticalCount, chainDelay } = wr;
  const href = (tab: string = 'progress') => `/orders/${order.id}?tab=${tab}`;

  // ── IMMEDIATE：最紧急的一件事 ──────────────────────────────

  const hasCriticalBlocked = rootCauses.some(c => c.code === 'BLOCKED' && c.severity === 'CRITICAL');
  const hasChain = !!chainDelay;
  const etdCritical = daysToAnchor !== null && daysToAnchor <= 5;

  if (hasCriticalBlocked) {
    // 阻塞节点是立即优先
    actions.push({
      id: id(), category: 'IMMEDIATE', categoryLabel: '立即处理', icon: '🔓',
      label: '解除阻塞节点',
      description: `订单有 ${blockedCount} 个节点阻塞，阻断后续执行链，需立即介入解决`,
      targetRole: '管理员',
      orderId: order.id, orderNo: order.order_no,
      ctaLabel: '查看阻塞', ctaHref: href(),
    });
  } else if (etdCritical) {
    // ETD 极近，通知客户是首要
    const daysStr = daysToAnchor! <= 0 ? '已过出货日' : `仅剩 ${daysToAnchor} 天`;
    actions.push({
      id: id(), category: 'IMMEDIATE', categoryLabel: '立即处理', icon: '📧',
      label: '主动通知客户',
      description: `出货日 ${daysStr}，需立即与客户沟通交期风险，确认是否需要调整`,
      targetRole: '业务',
      orderId: order.id, orderNo: order.order_no,
      ctaLabel: '进入订单', ctaHref: href('basic'),
    });
  } else if (hasChain && chainDelay!.chainLen >= 4) {
    // 链式延误：升级上报
    actions.push({
      id: id(), category: 'IMMEDIATE', categoryLabel: '立即处理', icon: '🚨',
      label: '升级至管理层',
      description: `从「${chainDelay!.rootNode}」开始 ${chainDelay!.chainLen} 个节点串联逾期，单靠执行层无法自行消化`,
      targetRole: '管理员',
      orderId: order.id, orderNo: order.order_no,
      ctaLabel: '查看订单', ctaHref: href(),
    });
  } else if (unassignedCriticalCount >= 3) {
    // 大量关键节点无人认领
    actions.push({
      id: id(), category: 'IMMEDIATE', categoryLabel: '立即处理', icon: '👤',
      label: '批量指派执行人',
      description: `${unassignedCriticalCount} 个关键节点无负责人，节点无法推进，需在今日内完成指派`,
      targetRole: '管理员',
      orderId: order.id, orderNo: order.order_no,
      ctaLabel: '指派负责人', ctaHref: href(),
    });
  } else if (wr.overdueCount > 0) {
    // 兜底：有逾期就催办
    const worstCause = rootCauses[0];
    actions.push({
      id: id(), category: 'IMMEDIATE', categoryLabel: '立即处理', icon: '⚡',
      label: worstCause ? worstCause.label : '催办逾期节点',
      description: worstCause
        ? worstCause.detail
        : `订单有 ${wr.overdueCount} 个逾期节点，需今日跟进`,
      targetRole: worstCause?.impactedStages[0] || '业务',
      orderId: order.id, orderNo: order.order_no,
      ctaLabel: '查看节点', ctaHref: href(),
    });
  }

  // ── RECOVERY：让订单回到正轨的具体路径 ───────────────────────

  if (hasChain && chainDelay) {
    // 链式延误的恢复：找到根因节点，集中攻克
    actions.push({
      id: id(), category: 'RECOVERY', categoryLabel: '恢复路径', icon: '🎯',
      label: `攻克根因节点：${chainDelay.rootNode}`,
      description: `优先完成「${chainDelay.rootNode}」后，后续 ${chainDelay.chainLen - 1} 个节点可自动推进，是最高效的恢复路径`,
      targetRole: order.milestones.find(m => m.name === chainDelay.rootNode)
        ? ROLE_LABELS[order.milestones.find(m => m.name === chainDelay.rootNode)!.owner_role] || '业务'
        : '业务',
      orderId: order.id, orderNo: order.order_no,
      ctaLabel: '跳转至节点', ctaHref: href(),
    });
  } else if (wr.bottleneckRoles.length > 0) {
    const role = wr.bottleneckRoles[0];
    actions.push({
      id: id(), category: 'RECOVERY', categoryLabel: '恢复路径', icon: '🔄',
      label: `${role}资源补充`,
      description: `${role}部门是当前瓶颈，建议临时调配资源或拆分任务，优先清理逾期节点`,
      targetRole: role,
      orderId: order.id, orderNo: order.order_no,
      ctaLabel: '查看节点', ctaHref: href(),
    });
  } else if (daysToAnchor !== null && daysToAnchor <= 14) {
    // ETD 临近，缩短各节点确认周期
    actions.push({
      id: id(), category: 'RECOVERY', categoryLabel: '恢复路径', icon: '📅',
      label: '压缩确认周期',
      description: `距出货日 ${Math.max(0, daysToAnchor)} 天，建议将剩余节点的确认时限压缩至1天内，确保不再累积延误`,
      targetRole: '业务',
      orderId: order.id, orderNo: order.order_no,
      ctaLabel: '查看排期', ctaHref: href(),
    });
  }

  // ── PREVENTION：防止下次出现同样问题（只在高风险以上展示）──

  if (riskLevel === 'CRITICAL' || riskLevel === 'HIGH') {
    if (rootCauses.some(c => c.code === 'CHAIN_DELAY')) {
      actions.push({
        id: id(), category: 'PREVENTION', categoryLabel: '预防措施', icon: '🛡',
        label: '产前会 + 节点指派',
        description: '链式延误根源通常是产前会未开、节点无人认领。建议在下单后48小时内完成产前会并锁定所有节点负责人',
        targetRole: '生产',
        orderId: order.id, orderNo: order.order_no,
        ctaLabel: '查看流程', ctaHref: href(),
      });
    } else if (daysToAnchor !== null && daysToAnchor <= 14) {
      actions.push({
        id: id(), category: 'PREVENTION', categoryLabel: '预防措施', icon: '🔔',
        label: '设置出货前7天预警',
        description: '建议为该客户订单设置 ETD-7 天预警规则，提前触发业务和物流协同确认，避免临门再处理',
        targetRole: '业务',
        orderId: order.id, orderNo: order.order_no,
        ctaLabel: '查看订单', ctaHref: href('basic'),
      });
    }
  }

  return actions.slice(0, 3); // 硬限：最多3条
}

/** 主入口：对所有 warRoom 订单生成行动建议 */
export function suggestActions(warRoomOrders: WarRoomOrder[]): SuggestedAction[] {
  _id = 0;
  return warRoomOrders.flatMap(wr => buildActionsForOrder(wr));
}

export function summarizeActions(actions: SuggestedAction[]): {
  immediate: number;
  recovery: number;
  prevention: number;
  total: number;
} {
  return {
    immediate:  actions.filter(a => a.category === 'IMMEDIATE').length,
    recovery:   actions.filter(a => a.category === 'RECOVERY').length,
    prevention: actions.filter(a => a.category === 'PREVENTION').length,
    total: actions.length,
  };
}
