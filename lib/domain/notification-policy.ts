/**
 * 通知频率策略 — 避免邮件轰炸
 *
 * 分 3 档：
 * - URGENT: 立即推送（站内通知 + 邮件 + 企微，需要立即响应的事件）
 * - DIGEST: 只站内，邮件合并到每日简报里（低频批量）
 * - STATION_ONLY: 只站内，永不邮件（纯信息流）
 *
 * 用法：
 *   import { getTier, shouldSendEmail } from '@/lib/domain/notification-policy';
 *   if (shouldSendEmail('delay_request')) { await sendEmailNotification(...); }
 */

export type NotificationTier = 'URGENT' | 'DIGEST' | 'STATION_ONLY';

/**
 * 通知类型 → 优先级档位
 *
 * 维护原则：
 * 1. URGENT 只给真正需要 1 小时内响应的事件
 * 2. DIGEST 占大多数 — 降噪重点
 * 3. 不在表里的类型默认走 DIGEST（保守策略）
 */
export const NOTIFICATION_TIERS: Record<string, NotificationTier> = {
  // ════════ URGENT — 立即推送邮件 + 站内 + 企微 ════════

  // 审批类 — 必须立刻响应
  delay_request: 'URGENT',        // 新延期申请 → 需要管理员立即审批
  delay_approved: 'URGENT',       // 延期已批准 → 申请人立即知晓
  delay_rejected: 'URGENT',       // 延期被驳回 → 申请人立即采取行动
  price_approval: 'URGENT',       // 价格审批结果 → 业务员立即继续创建订单
  price_approval_request: 'URGENT', // 新价格审批申请 → CEO 立即审批
  order_amendment: 'URGENT',      // 订单变更申请 → 立即审批
  cancel_request: 'URGENT',       // 取消订单申请 → 立即审批

  // 严重风险类 — 立即人工介入
  escalation: 'URGENT',           // CEO 级别升级
  ceo_alert: 'URGENT',            // CEO 警报
  delay_no_request: 'URGENT',     // 超期 24h 未申报延期
  delay_no_request_ceo: 'URGENT', // 超期 48h 未申报，CEO 警报
  delivery_delay_red: 'URGENT',   // 交期延迟红色预警
  blocked: 'URGENT',              // 里程碑被标记卡住

  // ════════ DIGEST — 只站内，邮件合并到每日简报 ════════

  overdue: 'DIGEST',              // 里程碑逾期（进入早 8 点简报）
  remind_48: 'DIGEST',            // 48h 临近到期
  remind_24: 'DIGEST',            // 24h 临近到期
  remind_12: 'DIGEST',            // 12h 临近到期
  reminder: 'DIGEST',             // 通用提醒

  email_draft: 'DIGEST',          // AI 草拟的回复
  email_change_detected: 'DIGEST',// 邮件-订单差异（已有 /email_diffs tab）
  email_urgent: 'DIGEST',         // 客户紧急邮件（简报突出）
  email_sample: 'DIGEST',         // 样品邮件
  mail_ingest: 'DIGEST',          // 邮件入库

  order_activated: 'DIGEST',      // 订单已激活
  order_completed: 'DIGEST',      // 订单已完成
  milestone_assigned: 'DIGEST',   // 里程碑分配

  customer_memory_update: 'DIGEST', // 客户画像更新
  agent_suggestion: 'DIGEST',     // Agent 建议

  // 手动催办（用户点「催办」按钮） — 用户显式意图，走 URGENT
  nudge: 'URGENT',

  // ════════ STATION_ONLY — 永不邮件，只站内 ════════

  system_info: 'STATION_ONLY',    // 系统信息
  data_refresh: 'STATION_ONLY',   // 数据刷新完成
  welcome: 'STATION_ONLY',        // 欢迎
  auth_event: 'STATION_ONLY',     // 登录/登出事件
  compliance_low: 'STATION_ONLY', // 低严重度合规提醒
};

/**
 * 获取某个通知类型的档位，未注册的类型默认 DIGEST
 */
export function getTier(type: string): NotificationTier {
  return NOTIFICATION_TIERS[type] || 'DIGEST';
}

/**
 * 该类型是否应该立即发送邮件
 * - URGENT → true
 * - 其它 → false（邮件只在每日简报里出现）
 */
export function shouldSendEmail(type: string): boolean {
  return getTier(type) === 'URGENT';
}

/**
 * 该类型是否应该立即推送企业微信 / 个人微信
 * 规则：和 shouldSendEmail 相同 — URGENT 才推
 */
export function shouldPushInstant(type: string): boolean {
  return getTier(type) === 'URGENT';
}

/**
 * 是否进入每日简报（早 8 点汇总）
 * - DIGEST → true
 * - URGENT → false（已经立即推送了，不再重复）
 * - STATION_ONLY → false（纯站内流水，不进简报）
 */
export function shouldAppearInDigest(type: string): boolean {
  return getTier(type) === 'DIGEST';
}
