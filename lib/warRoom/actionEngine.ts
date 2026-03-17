/**
 * Action Suggestion Engine — V1.2 War Room
 * 规则引擎：根据风险分析给出具体行动建议
 */

import type { WarRoomOrder, RootCause } from './rootCauseEngine';

export type ActionType =
  | 'ASSIGN_OWNER'
  | 'ESCALATE'
  | 'NOTIFY_CLIENT'
  | 'PRIORITIZE'
  | 'UNBLOCK'
  | 'EXPEDITE_SOURCING'
  | 'REQUEST_EXTENSION'
  | 'QC_INTERVENTION'
  | 'LOGISTICS_ALERT';

export type ActionPriority = 'IMMEDIATE' | 'TODAY' | 'THIS_WEEK';

export interface SuggestedAction {
  id: string;
  type: ActionType;
  priority: ActionPriority;
  label: string;
  description: string;
  targetRole: string;
  milestoneId?: string;
  milestoneName?: string;
  orderId: string;
  orderNo: string;
  canAutoExecute: boolean;
  /** 按钮文字 */
  ctaLabel: string;
  /** 路由目标 */
  ctaHref: string;
}

const ROLE_LABELS: Record<string, string> = {
  sales: '业务', finance: '财务', procurement: '采购',
  production: '生产', qc: '质检', logistics: '物流/仓库', admin: '管理员',
};

let _actionIdCounter = 0;
function makeId(prefix: string): string {
  return prefix + '_' + (++_actionIdCounter);
}

/** 根据根因生成行动建议 */
export function suggestActions(warRoomOrders: WarRoomOrder[]): SuggestedAction[] {
  _actionIdCounter = 0;
  const actions: SuggestedAction[] = [];

  for (const wr of warRoomOrders) {
    const { order, riskLevel, rootCauses, overdueCount, blockedCount,
            unassignedCriticalCount, daysToAnchor } = wr;

    // ── 1. 立即分配负责人 ──────────────────────────────────────
    if (unassignedCriticalCount > 0) {
      const unassigned = order.milestones.filter(
        m => m.is_critical && !m.owner_user_id && m.status !== '已完成'
      );
      for (const m of unassigned.slice(0, 2)) {
        actions.push({
          id: makeId('ASSIGN'),
          type: 'ASSIGN_OWNER',
          priority: 'IMMEDIATE',
          label: '指定执行人',
          description: `「${m.name}」无负责人，关键节点悬空，必须立即指派`,
          targetRole: ROLE_LABELS[m.owner_role] || m.owner_role,
          milestoneId: m.id,
          milestoneName: m.name,
          orderId: order.id,
          orderNo: order.order_no,
          canAutoExecute: false,
          ctaLabel: '前往指派',
          ctaHref: `/orders/${order.id}?tab=timeline`,
        });
      }
    }

    // ── 2. 解除阻塞 ───────────────────────────────────────────
    if (blockedCount > 0) {
      const blocked = order.milestones.filter(m => m.status === '阻塞');
      for (const m of blocked.slice(0, 2)) {
        actions.push({
          id: makeId('UNBLOCK'),
          type: 'UNBLOCK',
          priority: 'IMMEDIATE',
          label: '介入解除阻塞',
          description: `「${m.name}」已阻塞，阻断后续节点推进，需立即介入`,
          targetRole: ROLE_LABELS[m.owner_role] || m.owner_role,
          milestoneId: m.id,
          milestoneName: m.name,
          orderId: order.id,
          orderNo: order.order_no,
          canAutoExecute: false,
          ctaLabel: '查看阻塞',
          ctaHref: `/orders/${order.id}?tab=timeline`,
        });
      }
    }

    // ── 3. 升级上报（链式延误 或 CRITICAL）─────────────────────
    const hasChainDelay = rootCauses.some(c => c.code === 'CHAIN_DELAY');
    if (hasChainDelay || (riskLevel === 'CRITICAL' && overdueCount >= 5)) {
      actions.push({
        id: makeId('ESCALATE'),
        type: 'ESCALATE',
        priority: 'IMMEDIATE',
        label: '升级上报',
        description: hasChainDelay
          ? `订单存在链式延误，多个节点串联逾期，需管理层介入协调`
          : `订单风险已达 CRITICAL 级，${overdueCount} 个节点逾期，建议升级处理`,
        targetRole: '管理员',
        orderId: order.id,
        orderNo: order.order_no,
        canAutoExecute: false,
        ctaLabel: '查看订单',
        ctaHref: `/orders/${order.id}`,
      });
    }

    // ── 4. 通知客户（锚点临近）────────────────────────────────
    if (daysToAnchor !== null && daysToAnchor <= 7 && riskLevel !== 'LOW') {
      const daysStr = daysToAnchor <= 0
        ? '已过出货日'
        : `距出货日仅剩 ${daysToAnchor} 天`;
      actions.push({
        id: makeId('NOTIFY_CLIENT'),
        type: 'NOTIFY_CLIENT',
        priority: daysToAnchor <= 3 ? 'IMMEDIATE' : 'TODAY',
        label: '通知客户',
        description: `${daysStr}，当前仍有 ${order.milestones.filter(m=>m.status!=='已完成').length} 个节点未完成，建议提前与客户沟通`,
        targetRole: '业务',
        orderId: order.id,
        orderNo: order.order_no,
        canAutoExecute: false,
        ctaLabel: '联系业务',
        ctaHref: `/orders/${order.id}`,
      });
    }

    // ── 5. 采购加急（采购角色瓶颈）────────────────────────────
    const procurementBottleneck = rootCauses.find(
      c => c.code === 'ROLE_BOTTLENECK' && c.affectedRoles.includes('采购')
    );
    if (procurementBottleneck) {
      actions.push({
        id: makeId('EXPEDITE'),
        type: 'EXPEDITE_SOURCING',
        priority: 'TODAY',
        label: '采购加急',
        description: `采购部门有 ${procurementBottleneck.affectedMilestones.length} 个节点逾期，建议跟进供应商或切换备选`,
        targetRole: '采购',
        orderId: order.id,
        orderNo: order.order_no,
        canAutoExecute: false,
        ctaLabel: '查看采购节点',
        ctaHref: `/orders/${order.id}?tab=timeline`,
      });
    }

    // ── 6. QC 干预（QC 节点阻塞或逾期）────────────────────────
    const qcIssues = order.milestones.filter(
      m => m.owner_role === 'qc' && m.status !== '已完成' && (m.status === '阻塞' || (m.due_at && new Date(m.due_at) < new Date()))
    );
    if (qcIssues.length >= 2) {
      actions.push({
        id: makeId('QC'),
        type: 'QC_INTERVENTION',
        priority: 'TODAY',
        label: 'QC 检验干预',
        description: `QC 有 ${qcIssues.length} 个检验节点异常，可能影响验货放行和出货`,
        targetRole: '质检',
        orderId: order.id,
        orderNo: order.order_no,
        canAutoExecute: false,
        ctaLabel: '查看 QC 节点',
        ctaHref: `/orders/${order.id}?tab=timeline`,
      });
    }

    // ── 7. 物流预警（锚点前7天，订舱未完成）──────────────────
    const bookingMs = order.milestones.find(m => m.step_key === 'booking_done');
    if (bookingMs && bookingMs.status !== '已完成' && daysToAnchor !== null && daysToAnchor <= 7) {
      actions.push({
        id: makeId('LOGISTICS'),
        type: 'LOGISTICS_ALERT',
        priority: daysToAnchor <= 3 ? 'IMMEDIATE' : 'TODAY',
        label: '物流预警：订舱未完成',
        description: `距出货日仅剩 ${Math.max(0, daysToAnchor)} 天，订舱节点尚未完成，出货窗口即将关闭`,
        targetRole: '物流/仓库',
        milestoneId: bookingMs.id,
        milestoneName: bookingMs.name,
        orderId: order.id,
        orderNo: order.order_no,
        canAutoExecute: false,
        ctaLabel: '联系物流',
        ctaHref: `/orders/${order.id}?tab=timeline`,
      });
    }
  }

  // 优先级排序：IMMEDIATE > TODAY > THIS_WEEK
  const priorityOrder = { IMMEDIATE: 0, TODAY: 1, THIS_WEEK: 2 };
  return actions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
}

/** 统计行动建议汇总 */
export function summarizeActions(actions: SuggestedAction[]): {
  immediate: number;
  today: number;
  thisWeek: number;
  byType: Record<ActionType, number>;
} {
  const byType: Partial<Record<ActionType, number>> = {};
  for (const a of actions) {
    byType[a.type] = (byType[a.type] || 0) + 1;
  }
  return {
    immediate: actions.filter(a => a.priority === 'IMMEDIATE').length,
    today: actions.filter(a => a.priority === 'TODAY').length,
    thisWeek: actions.filter(a => a.priority === 'THIS_WEEK').length,
    byType: byType as Record<ActionType, number>,
  };
}
