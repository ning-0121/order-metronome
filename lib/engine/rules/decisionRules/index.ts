/**
 * Business Decision 规则注册中心
 *
 * Step 1（当前）：空。
 * Step 3 实现：
 *   - stopRules.ts     （任一命中 → STOP）
 *   - cautionRules.ts  （任一命中 → CAUTION，前提是无 STOP）
 */

import type { OrderContext, DecisionReason, DecisionBlocker, DecisionAction } from '@/lib/engine/types';

export interface DecisionRuleContribution {
  reasons?: DecisionReason[];
  blockers?: DecisionBlocker[];
  actions?: DecisionAction[];
}

export type DecisionRule = {
  code: string;
  evaluate: (ctx: OrderContext) => DecisionRuleContribution | null;
};

export const STOP_RULES: DecisionRule[] = [];
export const CAUTION_RULES: DecisionRule[] = [];
