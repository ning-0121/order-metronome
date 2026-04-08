/**
 * 报价员对外 API 入口
 *
 * 这个文件是外部系统/主系统调用报价员的唯一入口。
 * 其他地方不要直接 import fabric/ 或 cmt/。
 */

import type { QuoteInput, QuoteOutput } from './types';
import { calculateFabricConsumption } from './fabric/calculator';
import { calculateCmt } from './cmt/calculator';

export * from './types';
export { calculateFabricConsumption } from './fabric/calculator';
export { calculateCmt } from './cmt/calculator';
export { DEFAULT_SIZE_CHARTS, getChartOptions } from './fabric/defaultSizeCharts';
export { DEFAULT_OPERATIONS, getDefaultOperationsForType } from './cmt/defaultOperations';

/**
 * 一次性计算完整报价（面料 + 加工 + 其他 + 利润 → 最终报价）
 */
export function generateQuote(input: QuoteInput): QuoteOutput {
  // 1. 面料单耗
  const fabric = calculateFabricConsumption({
    garment_type: input.garment_type,
    subtype: input.subtype,
    size_chart: input.size_chart,
    fabric: input.fabric,
    size_distribution: input.size_distribution,
  });

  // 2. 加工费
  const cmt = calculateCmt({
    garment_type: input.garment_type,
    subtype: input.subtype,
    complexity: input.cmt_complexity || 'standard',
  });

  // 3. 成本汇总（RMB / 件）
  const fabricCost = fabric.avg_kg * (input.fabric.price_per_kg || 0);
  const cmtCost = cmt.total_rmb;
  const trimCost = input.trim_cost_per_piece || 0;
  const packingCost = input.packing_cost_per_piece || 0;
  const logisticsCost = input.logistics_cost_per_piece || 0;
  const subtotal = fabricCost + cmtCost + trimCost + packingCost + logisticsCost;

  // 4. 加利润率
  const marginRate = input.margin_rate ?? 15.0; // 默认 15%
  const quoteRmb = subtotal * (1 + marginRate / 100);

  // 5. 换币种
  const currency = input.currency || 'USD';
  const exchangeRate = input.exchange_rate || 7.2;
  const quoteCurrency =
    currency === 'RMB' ? quoteRmb : quoteRmb / exchangeRate;

  const totalCurrency = quoteCurrency * (input.quantity || 0);

  // 6. 整体置信度 = 两个子模块的加权
  const overallConfidence = Math.round(
    (fabric.confidence * 0.6 + cmt.confidence * 0.4),
  );

  return {
    fabric,
    cmt,
    costs: {
      fabric_rmb: Number(fabricCost.toFixed(2)),
      cmt_rmb: Number(cmtCost.toFixed(2)),
      trim_rmb: Number(trimCost.toFixed(2)),
      packing_rmb: Number(packingCost.toFixed(2)),
      logistics_rmb: Number(logisticsCost.toFixed(2)),
      subtotal_rmb: Number(subtotal.toFixed(2)),
    },
    quote_rmb_per_piece: Number(quoteRmb.toFixed(2)),
    quote_currency_per_piece: Number(quoteCurrency.toFixed(3)),
    total_currency: Number(totalCurrency.toFixed(2)),
    effective_margin_pct: marginRate,
    overall_confidence: overallConfidence,
  };
}
