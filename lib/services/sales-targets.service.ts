/**
 * 销售目标 — 纯函数（件数口径）
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
  targetQty: number;
  actualQty: number;
  progressPct: number;        // actual / target (0-1+)
  expectedQty: number;        // target × 已过年比例
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
 * 件数格式化：>= 10000 显示万件，否则件
 */
export function formatQty(qty: number): string {
  if (qty >= 10000) return `${(qty / 10000).toFixed(1)} 万件`;
  return `${qty.toLocaleString('zh-CN')} 件`;
}

/**
 * 评级 + 文字建议（纯规则，不调 AI）
 */
export function evaluatePerformance(
  performance: number,
  daysRemaining: number,
  actualQty: number,
  targetQty: number,
): TargetEvaluation {
  const gapQty = Math.max(0, targetQty - actualQty);
  const dailyNeed = daysRemaining > 0 ? gapQty / daysRemaining : 0;

  if (performance >= 1.1) {
    return {
      status: 'ahead',
      emoji: '🚀',
      label: '超出预期',
      color: 'green',
      suggestion: `已超出预期进度 ${((performance - 1) * 100).toFixed(0)}%，可以稳健推进。剩余 ${daysRemaining} 天，继续保持节奏即可。`,
    };
  }
  if (performance >= 0.9) {
    return {
      status: 'on_track',
      emoji: '✅',
      label: '进度正常',
      color: 'blue',
      suggestion: `节奏正常。剩余 ${daysRemaining} 天还需 ${formatQty(gapQty)} 即可达标，平均每天 ${Math.ceil(dailyNeed).toLocaleString('zh-CN')} 件。`,
    };
  }
  if (performance >= 0.7) {
    return {
      status: 'slight_behind',
      emoji: '🟡',
      label: '略有落后',
      color: 'amber',
      suggestion: `进度落后约 ${((1 - performance) * 100).toFixed(0)}%。剩余 ${daysRemaining} 天还差 ${formatQty(gapQty)}，建议本月主动跟进客户、推动新订单。`,
    };
  }
  return {
    status: 'behind',
    emoji: '🔴',
    label: '严重落后',
    color: 'red',
    suggestion: `严重落后年度目标（仅完成 ${(performance * 100).toFixed(0)}%）。剩余 ${daysRemaining} 天平均每天需 ${Math.ceil(dailyNeed).toLocaleString('zh-CN')} 件，建议立即拜访客户、协调内部资源加单。`,
  };
}

/**
 * 计算单个客户的进度对象
 */
export function computeTargetProgress(
  targetQty: number,
  actualQty: number,
  year: number,
  today: Date = new Date(),
): TargetProgress {
  const { daysElapsed, daysInYear, daysRemaining } = getYearProgress(year, today);

  const expectedQty = targetQty * (daysElapsed / daysInYear);
  const progressPct = targetQty > 0 ? actualQty / targetQty : 0;
  const performance = expectedQty > 0 ? actualQty / expectedQty : (actualQty > 0 ? 999 : 0);

  return {
    targetQty,
    actualQty,
    progressPct,
    expectedQty,
    performance,
    daysElapsed,
    daysInYear,
    daysRemaining,
    evaluation: evaluatePerformance(performance, daysRemaining, actualQty, targetQty),
  };
}
