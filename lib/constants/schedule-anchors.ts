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
export const OVERRIDABLE_STEPS: { step_key: string; name: string; stage: string }[] = [
  { step_key: 'pre_production_sample_ready',    name: '产前样准备完成',   stage: '产前样' },
  { step_key: 'pre_production_sample_sent',     name: '产前样寄出',       stage: '产前样' },
  { step_key: 'pre_production_sample_approved', name: '产前样客户确认',   stage: '产前样' },
  { step_key: 'shipping_sample_send',           name: '船样寄送',         stage: '出货控制' },
  { step_key: 'packing_method_confirmed',       name: '包装方式确认',     stage: '出货控制' },
  { step_key: 'mid_qc_check',                   name: '跟单中查',         stage: '品控' },
  { step_key: 'final_qc_check',                 name: '跟单尾查',         stage: '品控' },
  { step_key: 'inspection_release',             name: '验货/放行',        stage: '品控' },
  { step_key: 'payment_received',               name: '收款完成',         stage: '财务' },
];
