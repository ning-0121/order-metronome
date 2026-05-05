/**
 * 销售目标 — 纯函数（件数口径）
 * 进度计算 + 考评等级 + 文字建议（无 AI 调用）
 *
 * 年份口径：按中国农历新年划分
 *   "2026 农历年" = 2026-02-17（农历正月初一）至 2027-02-05（次年初一前一天）
 */

// ─────────────────────────────────────────────────────────────
// 农历新年日期表（公历）— 覆盖 2024-2032
// 数据源：中国国务院公历农历对照（精确到日）
// ─────────────────────────────────────────────────────────────
const LUNAR_NEW_YEAR_DATES: Record<number, string> = {
  2024: '2024-02-10',
  2025: '2025-01-29',
  2026: '2026-02-17',
  2027: '2027-02-06',
  2028: '2028-01-26',
  2029: '2029-02-13',
  2030: '2030-02-03',
  2031: '2031-01-23',
  2032: '2032-02-11',
  2033: '2033-01-31',
};

/**
 * 给定农历年份（如 2026），返回该农历年的公历起止日期。
 * - start：当年农历正月初一
 * - end：下一年农历正月初一（不含，半开区间）
 *
 * 范围外（< 2024 或 > 2032）退化为公历年（兜底）。
 */
export function getLunarYearRange(year: number): { start: Date; end: Date; startStr: string; endStr: string } {
  const startStr = LUNAR_NEW_YEAR_DATES[year];
  const endStr = LUNAR_NEW_YEAR_DATES[year + 1];
  if (!startStr || !endStr) {
    const start = new Date(year, 0, 1);
    const end = new Date(year + 1, 0, 1);
    return {
      start,
      end,
      startStr: `${year}-01-01`,
      endStr: `${year + 1}-01-01`,
    };
  }
  return {
    start: new Date(startStr),
    end: new Date(endStr),
    startStr,
    endStr,
  };
}

/**
 * 返回当前所处的"农历年"标号
 * 例：今天 2026-05-04 → 农历年 2026
 *     今天 2026-01-15（春节前）→ 农历年 2025
 */
export function getCurrentLunarYear(today: Date = new Date()): number {
  const years = Object.keys(LUNAR_NEW_YEAR_DATES).map(Number).sort((a, b) => a - b);
  let result = years[0];
  for (const y of years) {
    if (new Date(LUNAR_NEW_YEAR_DATES[y]) <= today) result = y;
    else break;
  }
  return result;
}

/**
 * 农历年范围内"已过天数 / 全年总天数"
 */
export function getLunarYearProgress(year: number, today: Date = new Date()): {
  daysElapsed: number;
  daysInYear: number;
  daysRemaining: number;
} {
  const { start, end } = getLunarYearRange(year);
  const daysInYear = Math.round((end.getTime() - start.getTime()) / 86400000);

  const cur = new Date(today);
  cur.setHours(0, 0, 0, 0);

  let daysElapsed: number;
  if (cur < start) daysElapsed = 0;
  else if (cur >= end) daysElapsed = daysInYear;
  else daysElapsed = Math.floor((cur.getTime() - start.getTime()) / 86400000) + 1;

  return {
    daysElapsed,
    daysInYear,
    daysRemaining: Math.max(0, daysInYear - daysElapsed),
  };
}


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
 * @deprecated 用 getLunarYearProgress（按农历年）— 此函数仅做兼容兜底
 */
export function getYearProgress(year: number, today: Date = new Date()) {
  return getLunarYearProgress(year, today);
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
  // 使用农历年范围
  const { daysElapsed, daysInYear, daysRemaining } = getLunarYearProgress(year, today);

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
