/**
 * Root Cause 规则注册中心
 *
 * Step 2 已注册 5 条核心规则（覆盖付款/利润/确认链/质量/延期五大领域）。
 * 后续按 domain 追加规则。
 */

import type { CauseRule } from '@/lib/engine/types';
import { paymentCauseRules } from './paymentCauses';
import { profitCauseRules } from './profitCauses';
import { confirmationCauseRules } from './confirmationCauses';
import { qualityCauseRules } from './qualityCauses';
import { delayCauseRules } from './delayCauses';

/** 全部已注册的规则列表 */
export const ALL_CAUSE_RULES: CauseRule[] = [
  ...paymentCauseRules,
  ...profitCauseRules,
  ...confirmationCauseRules,
  ...qualityCauseRules,
  ...delayCauseRules,
];

export function getRuleByCode(code: string): CauseRule | undefined {
  return ALL_CAUSE_RULES.find(r => r.code === code);
}
