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
 * 主入口：纯函数，永不抛错
 */
export function generateBusinessDecision(ctx: OrderContext | null): BusinessDecision {
  if (!businessDecisionEngineEnabled()) return defaultProceed();
  if (!ctx) return defaultProceed();

  const reasons: DecisionReason[] = [];
  const blockers: DecisionBlocker[] = [];
  const actions: DecisionAction[] = [];
  const rulesFired: string[] = [];
  const errors: string[] = [];

  // ─── STOP 规则 ───
  let hasStop = false;
  for (const rule of STOP_RULES) {
    try {
      const r = rule.evaluate(ctx);
      if (r) {
        if (r.reasons) reasons.push(...r.reasons);
        if (r.blockers) {
          blockers.push(...r.blockers);
          hasStop = true;
        }
        if (r.actions) actions.push(...r.actions);
        rulesFired.push(rule.code);
      }
    } catch (err: any) {
      errors.push(`stop:${rule.code}:${err?.message ?? 'unknown'}`);
    }
  }

  // ─── CAUTION 规则 ───
  let hasCaution = false;
  for (const rule of CAUTION_RULES) {
    try {
      const r = rule.evaluate(ctx);
      if (r) {
        if (r.reasons && r.reasons.length > 0) {
          reasons.push(...r.reasons);
          hasCaution = true;
        }
        if (r.actions) actions.push(...r.actions);
        rulesFired.push(rule.code);
      }
    } catch (err: any) {
      errors.push(`caution:${rule.code}:${err?.message ?? 'unknown'}`);
    }
  }

  // 全部失败 → fallback
  if (errors.length > 0 && rulesFired.length === 0) {
    return fallbackCaution(errors);
  }

  // 决议
  let decision: 'PROCEED' | 'CAUTION' | 'STOP' = 'PROCEED';
  if (hasStop) decision = 'STOP';
  else if (hasCaution) decision = 'CAUTION';

  const priority = blockers.length > 0
    ? 'critical'
    : maxSeverity(reasons.map(r => r.severity));

  const summary = decision === 'STOP'
    ? `🛑 阻断：${blockers[0]?.block_title ?? '关键问题待处理'}`
    : decision === 'CAUTION'
      ? `⚠️ 注意：${reasons[0]?.title ?? '存在风险因素'}`
      : '✅ 一切正常，可以推进';

  return {
    decision,
    priority,
    confidence: errors.length === 0 ? 0.95 : 0.7,
    summary,
    reasons,
    recommended_actions: actions,
    blockers,
    meta: {
      engine_version: ENGINE_VERSION,
      generated_at: new Date().toISOString(),
      rules_fired: rulesFired,
      fallback: false,
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
