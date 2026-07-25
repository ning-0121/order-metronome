/**
 * Knowledge Layer K1 — Outcome 自动信号（纯函数，只读现有采购数据算）
 *
 * 关键纪律：这里只产出「自动信号」和「建议」——是不是因果、决策到底对不对，
 * 必须由人在 evaluate 时判定（outcome_was_correct）。绝不把相关性当因果。
 * 详见 Q4 / 设计文档。
 */

import type { OutcomeAutoSignals, OutcomeResult } from './types';

export interface OutcomeComputeInput {
  /** 该决策相关物料在本单的核料确认项（procurement_items） */
  procurementItems?: Array<{
    is_supplement?: boolean | null;
    supplement_reason?: string | null;
    supplement_base_item_id?: string | null;
    suggested_purchase_qty?: number | null;
    final_purchase_qty?: number | null;
  }>;
  /** 执行行（procurement_line_items）的到货 vs 下单偏差 */
  lineItems?: Array<{ difference_pct?: number | null }>;
  /** 计划 vs 实际 材料成本（order_financials 口径），可空 */
  costPlanned?: number | null;
  costActual?: number | null;
  nowIso?: string;
}

const num = (v: any): number | null => {
  if (v === '' || v == null) return null;
  const x = Number(v);
  return isNaN(x) ? null : x;
};

export function computeOutcomeSignals(input: OutcomeComputeInput): OutcomeAutoSignals {
  const items = input.procurementItems || [];
  const supplement = items.find(i => i.is_supplement);
  const isSupplement = !!supplement;
  // supplement_base_item_id 指回原项 = 「数量补」= 很可能单耗定低了（最强信号，但仍需人判因果）
  const isQuantitySupplement = !!supplement?.supplement_base_item_id;

  // 超买：final > suggested
  let overPurchase: boolean | null = null;
  for (const i of items) {
    const sug = num(i.suggested_purchase_qty);
    const fin = num(i.final_purchase_qty);
    if (sug != null && fin != null && sug > 0) {
      if (fin > sug * 1.1) { overPurchase = true; break; }
      overPurchase = false;
    }
  }

  // 到货 vs 下单 偏差%（取绝对值最大的一条）
  let differencePct: number | null = null;
  for (const l of input.lineItems || []) {
    const d = num(l.difference_pct);
    if (d != null && (differencePct == null || Math.abs(d) > Math.abs(differencePct))) differencePct = d;
  }

  // 材料成本差%
  let costVariancePct: number | null = null;
  const cp = num(input.costPlanned);
  const ca = num(input.costActual);
  if (cp != null && cp !== 0 && ca != null) costVariancePct = (ca - cp) / cp;

  return {
    is_supplement: isSupplement,
    supplement_qty: null,
    supplement_reason: supplement?.supplement_reason ?? null,
    over_purchase: overPurchase,
    difference_pct: differencePct,
    cost_variance_pct: costVariancePct,
    computed_at: input.nowIso,
    note: isQuantitySupplement ? '存在数量补料，疑似单耗定低（需人工判因果）' : undefined,
  };
}

/**
 * 仅作「建议」返回给人参考，绝不自动落 outcome_result。
 * 有数量补料 → 建议 too_low；明显超买 → 建议 too_high；都没有 → correct 待人确认；否则 inconclusive。
 */
export function suggestOutcome(signals: OutcomeAutoSignals): OutcomeResult | null {
  if (signals.is_supplement) return 'too_low_caused_supplement';
  if (signals.over_purchase === true) return 'too_high_caused_waste';
  if (signals.over_purchase === false && !signals.is_supplement) return 'correct';
  return 'inconclusive';
}
