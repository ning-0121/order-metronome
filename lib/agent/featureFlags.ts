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
};
