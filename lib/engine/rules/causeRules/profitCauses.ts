/**
 * 利润类根因规则
 */

import type { CauseRule, CauseEvaluation } from '@/lib/engine/types';

/**
 * PROFIT_NEGATIVE_MARGIN
 * 触发：毛利率 ≤ 0
 */
const profitNegativeMargin: CauseRule = {
  code: 'PROFIT_NEGATIVE_MARGIN',
  domain: 'profit',
  type: 'LOW_MARGIN',
  title: '订单利润为负 — 亏损风险',
  evaluate: (ctx): CauseEvaluation | null => {
    const margin = ctx.signals.marginPct;
    if (margin === null) return null;
    if (margin > 0) return null;

    const baseline = ctx.baseline as any;
    const fin = ctx.financials as any;

    return {
      matched: true,
      stage: null,
      severity: 'critical',
      impact_days: 0,
      impact_cost: baseline?.total_cost_per_piece && ctx.order.quantity
        ? Number(baseline.total_cost_per_piece) * Number(ctx.order.quantity || 0) * Math.abs(margin) / 100
        : 0,
      responsible_role: 'finance',
      evidence: {
        margin_pct: margin,
        total_cost_per_piece: baseline?.total_cost_per_piece,
        fob_price: baseline?.fob_price,
        ddp_price: baseline?.ddp_price,
        quantity: ctx.order.quantity,
        margin_source: fin?.margin_pct != null ? 'order_financials' : 'computed_from_baseline',
      },
      confidence: 0.95,
      description: `毛利率为 ${margin.toFixed(2)}%（≤ 0）。订单将亏损，建议财务和业务复核报价。`,
    };
  },
};

export const profitCauseRules: CauseRule[] = [profitNegativeMargin];
