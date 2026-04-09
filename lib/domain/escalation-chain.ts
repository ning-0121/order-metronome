/**
 * 自动升级链 — 逾期节点的分级处理
 *
 * CEO 2026-04-09 规则：
 *   Day +1: 催办责任人（站内+微信）
 *   Day +2: 上报直属主管（生产主管 / 业务主管）
 *   Day +3: 上报 CEO + 行政督办 + 标红
 *   Day +5: 标记为"严重阻塞"，在 CEO 仪表盘置顶
 *
 * 去重：每个节点每个升级级别只触发一次
 * 触发时机：reminders cron 每 15 分钟跑
 */

export interface EscalationAction {
  level: 1 | 2 | 3 | 4;
  label: string;
  daysOverdue: number;
  notifyRoles: string[];           // 通知哪些角色
  notifyOwner: boolean;            // 是否通知节点责任人
  notifyOrderCreator: boolean;     // 是否通知订单创建者
  notificationPrefix: string;      // 通知标题前缀
}

export const ESCALATION_CHAIN: EscalationAction[] = [
  {
    level: 1,
    label: '催办责任人',
    daysOverdue: 1,
    notifyRoles: [],
    notifyOwner: true,
    notifyOrderCreator: false,
    notificationPrefix: '⏰',
  },
  {
    level: 2,
    label: '上报主管',
    daysOverdue: 2,
    notifyRoles: ['production_manager'],
    notifyOwner: true,
    notifyOrderCreator: true,
    notificationPrefix: '⚠️',
  },
  {
    level: 3,
    label: '上报 CEO',
    daysOverdue: 3,
    notifyRoles: ['admin', 'admin_assistant'],
    notifyOwner: true,
    notifyOrderCreator: true,
    notificationPrefix: '🚨',
  },
  {
    level: 4,
    label: '严重阻塞',
    daysOverdue: 5,
    notifyRoles: ['admin'],
    notifyOwner: true,
    notifyOrderCreator: true,
    notificationPrefix: '🔴🔴',
  },
];

/**
 * 根据逾期天数决定当前应该触发哪个升级级别
 */
export function getEscalationLevel(daysOverdue: number): EscalationAction | null {
  // 从最高级别向下找，返回当前应触发的最高级别
  for (let i = ESCALATION_CHAIN.length - 1; i >= 0; i--) {
    if (daysOverdue >= ESCALATION_CHAIN[i].daysOverdue) {
      return ESCALATION_CHAIN[i];
    }
  }
  return null;
}

/**
 * 生成升级通知的去重 key
 */
export function escalationDedupKey(milestoneId: string, level: number): string {
  return `escalation_${milestoneId}_L${level}`;
}
