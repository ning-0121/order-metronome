// 客户节奏偏好的可用锚点类型 — 纯常量，可在客户端/服务端共享

export type ScheduleAnchor = 'factory_date' | 'order_date' | 'eta';

export const ANCHOR_LABEL: Record<ScheduleAnchor, string> = {
  factory_date: '离厂日 / ETD',
  order_date: '下单日',
  eta: 'ETA 到港日',
};

export interface ScheduleOverrideRule {
  anchor: ScheduleAnchor;
  offset_days: number; // 负数 = 锚点之前；正数 = 锚点之后
  note?: string;
}

export type CustomerScheduleOverrides = Record<string, ScheduleOverrideRule>;

/** 白名单：哪些 step_key 允许被客户偏好覆盖 */
// V2 标准模板节点键(2026-07-27 起新单全 V2;客户节奏偏好按 step_key 精确匹配,必须用真实 V2 键)。
// 修:去掉幻影 pre_production_sample_ready;中查/尾查改 V2 键 mid_qc_sales_check/final_qc_sales_check
// (旧键 mid_qc_check 任何模板都不产生、final_qc_check 是 V1 独有,对 V2 新单静默不生效)。存量偏好为 0,无需迁移。
export const OVERRIDABLE_STEPS: { step_key: string; name: string; stage: string }[] = [
  { step_key: 'pre_production_sample_sent',     name: '产前样寄出',       stage: '产前样' },
  { step_key: 'pre_production_sample_approved', name: '产前样客户确认',   stage: '产前样' },
  { step_key: 'shipping_sample_send',           name: '船样寄送',         stage: '出货控制' },
  { step_key: 'packing_method_confirmed',       name: '包装方式确认',     stage: '出货控制' },
  { step_key: 'mid_qc_sales_check',             name: '跟单中查',         stage: '品控' },
  { step_key: 'final_qc_sales_check',           name: '跟单尾查',         stage: '品控' },
  { step_key: 'payment_received',               name: '收款完成',         stage: '财务' },
];
