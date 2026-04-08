/**
 * Agent Feature Flags — 管理员可按功能开关Agent能力
 *
 * 通过环境变量控制，不需要改代码即可关闭某个Agent功能
 * 环境变量格式：AGENT_FLAG_xxx=false 关闭
 */

export const AGENT_FLAGS = {
  /** 自动催办通知 */
  autoNudge: () => process.env.AGENT_FLAG_AUTO_NUDGE !== 'false',
  /** 自动通知下一节点 */
  autoNotifyNext: () => process.env.AGENT_FLAG_AUTO_NOTIFY !== 'false',
  /** 链式动作（催办→升级） */
  chainActions: () => process.env.AGENT_FLAG_CHAIN !== 'false',
  /** 跨订单协调 */
  crossOrderAnalysis: () => process.env.AGENT_FLAG_CROSS_ORDER !== 'false',
  /** Claude AI 增强 */
  aiEnhance: () => process.env.AGENT_FLAG_AI_ENHANCE !== 'false',
  /** 预测性提醒 */
  predictiveWarning: () => process.env.AGENT_FLAG_PREDICTION !== 'false',
  /** 微信推送 */
  wechatPush: () => process.env.AGENT_FLAG_WECHAT !== 'false',
  /** 客户画像驱动 */
  customerProfile: () => process.env.AGENT_FLAG_CUSTOMER_PROFILE !== 'false',
  /** 工厂产能感知 */
  factoryProfile: () => process.env.AGENT_FLAG_FACTORY_PROFILE !== 'false',
  /** 邮件-订单执行对照 */
  complianceCheck: () => process.env.AGENT_FLAG_COMPLIANCE !== 'false',
  /** 业务员每日简报 */
  dailyBriefing: () => process.env.AGENT_FLAG_DAILY_BRIEFING !== 'false',
};

/**
 * AI Skills 开关 — 默认全部 false，必须显式设置 SKILL_*=true 才生效
 *
 * Phase 1（本周）：missing_info / risk_assessment / quote_review
 * Phase 2（下周）：delay_prediction / customer_confirmation
 * Phase 3（后续）：outsource_risk / milestone_generation
 *
 * Shadow Mode 默认开启（写日志但不展示给用户），需要显式 SKILL_SHADOW_MODE=false 才关
 */
export const SKILL_FLAGS = {
  // Phase 1
  riskAssessment: () => process.env.SKILL_RISK_ASSESSMENT === 'true',
  missingInfo: () => process.env.SKILL_MISSING_INFO === 'true',
  quoteReview: () => process.env.SKILL_QUOTE_REVIEW === 'true',
  customerEmailInsights: () => process.env.SKILL_CUSTOMER_EMAIL_INSIGHTS === 'true',
  // Phase 2
  delayPrediction: () => process.env.SKILL_DELAY_PREDICTION === 'true',
  customerConfirmation: () => process.env.SKILL_CUSTOMER_CONFIRMATION === 'true',
  // Phase 3
  outsourceRisk: () => process.env.SKILL_OUTSOURCE_RISK === 'true',
  milestoneGeneration: () => process.env.SKILL_MILESTONE_GENERATION === 'true',
  // 全局 shadow 模式（默认 ON — 第一周必须先观察日志）
  shadowMode: () => process.env.SKILL_SHADOW_MODE !== 'false',
};
