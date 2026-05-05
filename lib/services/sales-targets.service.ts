/**
 * 销售目标 — 纯函数
 * 进度计算 + 考评等级 + 文字建议（无 AI 调用）
 */

export type TargetStatus = 'ahead' | 'on_track' | 'slight_behind' | 'behind';

export interface TargetEvaluation {
  status: TargetStatus;
  emoji: string;
  label: string;
  color: 'green' | 'blue' | 'amber' | 'red';
  suggestion: string;
}

export interface TargetProgress {
  targetCny: number;
  actualCny: number;
  progressPct: number;        // actual / target (0-1+)
  expectedCny: number;        // target × 已过年比例
  performance: number;        // actual / expected (1.0 = 正好)
  daysElapsed: number;
  daysInYear: number;
  daysRemaining: number;
  evaluation: TargetEvaluation;
}

/**
 * 当年已过天数 / 全年总天数
 */
export function getYearProgress(year: number, today: Date = new Date()): {
  daysElapsed: number;
  daysInYear: number;
  daysRemaining: number;
} {
  const yearStart = new Date(year, 0, 1);
  const yearEnd = new Date(year, 11, 31);
  const daysInYear = Math.ceil((yearEnd.getTime() - yearStart.getTime()) / 86400000) + 1;

  const cur = new Date(today);
  cur.setHours(0, 0, 0, 0);

  // 如果 today < yearStart：返回 0；如果 > yearEnd：返回 daysInYear
  let daysElapsed: number;
  if (cur < yearStart) daysElapsed = 0;
  else if (cur > yearEnd) daysElapsed = daysInYear;
  else daysElapsed = Math.floor((cur.getTime() - yearStart.getTime()) / 86400000) + 1;

  return {
    daysElapsed,
    daysInYear,
    daysRemaining: Math.max(0, daysInYear - daysElapsed),
  };
}

/**
 * 评级 + 文字建议（纯规则，不调 AI）
 */
export function evaluatePerformance(
  performance: number,
  daysRemaining: number,
  actualCny: number,
  targetCny: number,
): TargetEvaluation {
  const gapCny = Math.max(0, targetCny - actualCny);
  const dailyNeed = daysRemaining > 0 ? gapCny / daysRemaining : 0;
  const dailyNeedWan = (dailyNeed / 10000).toFixed(1);

  if (performance >= 1.1) {
    return {
      status: 'ahead',
      emoji: '🚀',
      label: '超出预期',
      color: 'green',
      suggestion: `已超出预期进度 ${((performance - 1) * 100).toFixed(0)}%，可以适当稳健推进。剩余 ${daysRemaining} 天，继续保持节奏即可。`,
    };
  }
  if (performance >= 0.9) {
    return {
      status: 'on_track',
      emoji: '✅',
      label: '进度正常',
      color: 'blue',
      suggestion: `节奏正常。剩余 ${daysRemaining} 天还需 ¥${gapCny.toLocaleString('zh-CN', { maximumFractionDigits: 0 })} 即可达标，平均每天 ¥${dailyNeedWan} 万。`,
    };
  }
  if (performance >= 0.7) {
    return {
      status: 'slight_behind',
      emoji: '🟡',
      label: '略有落后',
      color: 'amber',
      suggestion: `进度落后约 ${((1 - performance) * 100).toFixed(0)}%。剩余 ${daysRemaining} 天还差 ¥${gapCny.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}，建议本月主动跟进客户、推动新订单。`,
    };
  }
  return {
    status: 'behind',
    emoji: '🔴',
    label: '严重落后',
    color: 'red',
    suggestion: `严重落后年度目标（仅完成 ${(performance * 100).toFixed(0)}%）。剩余 ${daysRemaining} 天平均每天需 ¥${dailyNeedWan} 万，建议立即拜访客户、协调内部资源加单。`,
  };
}

/**
 * 计算单个客户的进度对象
 */
export function computeTargetProgress(
  targetCny: number,
  actualCny: number,
  year: number,
  today: Date = new Date(),
): TargetProgress {
  const { daysElapsed, daysInYear, daysRemaining } = getYearProgress(year, today);

  const expectedCny = targetCny * (daysElapsed / daysInYear);
  const progressPct = targetCny > 0 ? actualCny / targetCny : 0;
  const performance = expectedCny > 0 ? actualCny / expectedCny : (actualCny > 0 ? 999 : 0);

  return {
    targetCny,
    actualCny,
    progressPct,
    expectedCny,
    performance,
    daysElapsed,
    daysInYear,
    daysRemaining,
    evaluation: evaluatePerformance(performance, daysRemaining, actualCny, targetCny),
  };
}

/**
 * 把订单实际销售额折算成 CNY
 *  - 优先用 sale_total（财务录入的总额）
 *  - 没有 → 用 sale_price_per_piece × quantity
 *  - sale_currency 是 USD/外币 → × exchange_rate（默认 7.2）
 */
export function getOrderRevenueCny(
  orderFinancials: any | null | undefined,
  orderQuantity: number | null | undefined,
): number {
  if (!orderFinancials) return 0;
  const rate = Number(orderFinancials.exchange_rate) || 7.2;
  const currency = (orderFinancials.sale_currency || 'USD').toUpperCase();

  let totalNative = Number(orderFinancials.sale_total) || 0;
  if (!totalNative) {
    const unit = Number(orderFinancials.sale_price_per_piece) || 0;
    const qty = Number(orderQuantity) || 0;
    totalNative = unit * qty;
  }
  if (!totalNative) return 0;

  if (currency === 'CNY' || currency === 'RMB') return totalNative;
  return totalNative * rate;
}
