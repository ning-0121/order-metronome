/**
 * Root Cause 规则注册中心
 *
 * Step 1（当前）：空注册表，引擎可调用但不会触发任何规则。
 * Step 2（下次）：在此 import 各 domain 的规则文件并注册。
 *
 * 规则文件按 domain 分组：
 *   - delayCauses.ts
 *   - profitCauses.ts
 *   - paymentCauses.ts
 *   - confirmationCauses.ts
 *   - qualityCauses.ts
 */

import type { CauseRule } from '@/lib/engine/types';

/** 全部已注册的规则列表 */
export const ALL_CAUSE_RULES: CauseRule[] = [
  // Step 2 在此追加：
  // ...delayCauseRules,
  // ...profitCauseRules,
  // ...paymentCauseRules,
  // ...confirmationCauseRules,
  // ...qualityCauseRules,
];

export function getRuleByCode(code: string): CauseRule | undefined {
  return ALL_CAUSE_RULES.find(r => r.code === code);
}
