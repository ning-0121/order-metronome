// Pure constants — shareable between client/server without 'use server' restrictions.

export type DelayReasonType = 'upstream' | 'customer_change' | 'internal' | 'force_majeure' | 'other';

export const DELAY_REASON_LABEL: Record<DelayReasonType, string> = {
  upstream: '上游延误',
  customer_change: '客户变更',
  internal: '内部失误',
  force_majeure: '不可抗力',
  other: '其他',
};
