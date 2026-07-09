/**
 * Business Decision Engine — 经营决策引擎
 *
 * 职责：基于 OrderContext + active root causes，输出 PROCEED/CAUTION/STOP 决策
 *
 * 特性：
 *   - 纯函数，无副作用，不写库
 *   - 任意子规则抛错 → 该规则计入 errors 但不中断
 *   - 全部规则失败 → fallback 到 CAUTION 而非崩溃
 *   - 与 redactDecisionForRole 配合按角色脱敏
 *
 * 当前 Step 1 状态：骨架完成，stopRules/cautionRules 为空时返回 PROCEED。
 */

import { businessDecisionEngineEnabled } from './featureFlags';
import { STOP_RULES, CAUTION_RULES } from './rules/decisionRules';
import {
  ENGINE_VERSION,
  type BusinessDecision,
  type DecisionAction,
  type DecisionBlocker,
  type DecisionReason,
  type OrderContext,
  type Severity,
} from './types';

const SEVERITY_ORDER: Record<Severity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function maxSeverity(arr: Severity[]): Severity {
  if (arr.length === 0) return 'low';
  return arr.reduce((acc, s) => (SEVERITY_ORDER[s] > SEVERITY_ORDER[acc] ? s : acc), arr[0]);
}

/** 兜底 PROCEED 决策（flag 关闭或上下文缺失时返回） */
function defaultProceed(): BusinessDecision {
  return {
    decision: 'PROCEED',
    priority: 'low',
    confidence: 1,
    summary: '暂无决策（引擎未启用或上下文缺失）',
    reasons: [],
    recommended_actions: [],
    blockers: [],
    meta: {
      engine_version: ENGINE_VERSION,
      generated_at: new Date().toISOString(),
      rules_fired: [],
      fallback: true,
    },
  };
}

/** 兜底 CAUTION（全部规则失败时返回，避免页面崩溃） */
function fallbackCaution(errors: string[]): BusinessDecision {
  return {
    decision: 'CAUTION',
    priority: 'medium',
    confidence: 0.5,
    summary: '决策引擎降级运行（规则评估失败）',
    reasons: [],
    recommended_actions: [],
    blockers: [],
    meta: {
      engine_version: ENGINE_VERSION,
      generated_at: new Date().toISOString(),
      rules_fired: errors,
      fallback: true,
    },
  };
}

/**
 * 按角色脱敏：去掉敏感的 profit/payment 类原因和金额
 * 规则：
 *   - admin / finance / 订单创建者：完整可见
 *   - 其他角色：移除 profit/payment domain 的 reasons 与 blockers
 */
export function redactDecisionForRole(
  decision: BusinessDecision,
  roles: string[],
  isOrderOwner: boolean = false,
): BusinessDecision {
  const lower = roles.map(r => r.toLowerCase());
  const hasFinancialView = isOrderOwner || lower.some(r => ['admin', 'finance'].includes(r));
  if (hasFinancialView) return decision;

  const SENSITIVE_BLOCK_CODES = new Set([
    'NEGATIVE_MARGIN',
    'PAYMENT_HOLD_PRODUCTION',
    'PAYMENT_HOLD_SHIPMENT',
    'PAYMENT_HOLD',
  ]);

  return {
    ...decision,
    reasons: decision.reasons.filter(
      r => !r.code.startsWith('PROFIT_') && !r.code.startsWith('PAYMENT_'),
    ),
    blockers: decision.blockers.filter(b => !SENSITIVE_BLOCK_CODES.has(b.block_code)),
  };
}
