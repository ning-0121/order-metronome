/**
 * 佣金金额化配置(2026-07-21 冲90资金流第3块)。
 *
 * 应发佣金 = 佣金基数 × 标准佣金率 × 绩效系数(order_commissions.commission_rate,0.5~1.1)。
 * 标准率在此集中配置,便于统一调整(以后可接系统设置页覆盖)。
 */

/** 佣金基数口径:revenue=订单成交额 / profit=毛利。默认成交额。 */
export const COMMISSION_BASE_TYPE: 'revenue' | 'profit' = 'revenue';

/** 标准佣金率:基数的百分之几(默认 1% = 0.01,用户 2026-07-21 拍板)。改这里即全局生效。 */
export const COMMISSION_BASE_RATE = 0.01;

/** 计算应发佣金金额(RMB)。base=基数(RMB),perfMultiplier=绩效系数。 */
export function computeCommissionAmount(base: number, perfMultiplier: number): number {
  if (!(base > 0) || !(perfMultiplier > 0)) return 0;
  return Math.round(base * COMMISSION_BASE_RATE * perfMultiplier * 100) / 100;
}
