/**
 * 生产排单 P2 —— 按月产能账 + 超卖检查,纯函数零副作用,server/client 共用。
 * 把一段排产窗口的件数按天数比例分摊到各月;工厂各月已派 vs 月产能 → 剩余/超卖。
 */

/** 一段窗口 [start,end] 的件数按天数比例分摊到各月:{ '2026-08': 480, '2026-09': 960 }。窗口缺则空。 */
export function allocateQtyToMonths(qty: number | null | undefined, start?: string | null, end?: string | null): Record<string, number> {
  const q = Number(qty) || 0;
  if (q <= 0 || !start || !end) return {};
  const s = new Date(`${String(start).slice(0, 10)}T00:00:00`);
  const e = new Date(`${String(end).slice(0, 10)}T00:00:00`);
  if (isNaN(s.getTime()) || isNaN(e.getTime()) || e < s) return {};
  const dayByMonth: Record<string, number> = {};
  let total = 0;
  for (const d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    dayByMonth[m] = (dayByMonth[m] || 0) + 1; total++;
  }
  const out: Record<string, number> = {};
  const keys = Object.keys(dayByMonth);
  let assigned = 0;
  keys.forEach((m, i) => {
    // 最后一个月吃余数,保证 Σ = q(避免四舍五入丢件)
    out[m] = i === keys.length - 1 ? q - assigned : Math.round(q * dayByMonth[m] / total);
    assigned += out[m];
  });
  return out;
}

/** 工厂各月已派件数(传入该厂活跃派工行)。 */
export function factoryMonthlyLoad(dispatches: Array<{ planned_qty?: number | null; planned_start?: string | null; planned_end?: string | null }>): Record<string, number> {
  const load: Record<string, number> = {};
  for (const d of (dispatches || [])) {
    const alloc = allocateQtyToMonths(d.planned_qty, d.planned_start, d.planned_end);
    for (const [m, q] of Object.entries(alloc)) load[m] = (load[m] || 0) + q;
  }
  return load;
}

export interface OverbookDetail { month: string; committed: number; add: number; after: number; capacity: number; over: boolean; }

/** 超卖检查:现有月负荷 + 本次派工分摊 vs 月产能。无产能/无窗口 → 不拦(over=false)。 */
export function checkOverbook(existingLoad: Record<string, number>, monthlyCapacity: number | null | undefined, newQty: number | null | undefined, start?: string | null, end?: string | null): { over: boolean; details: OverbookDetail[] } {
  const cap = Number(monthlyCapacity) || 0;
  if (cap <= 0) return { over: false, details: [] };
  const alloc = allocateQtyToMonths(newQty, start, end);
  const details: OverbookDetail[] = Object.entries(alloc).map(([month, add]) => {
    const committed = existingLoad[month] || 0;
    const after = committed + add;
    return { month, committed, add, after, capacity: cap, over: after > cap };
  });
  return { over: details.some((d) => d.over), details };
}

/** 近 N 个月的产能账(展示用):[{month, committed, capacity, remaining}]。 */
export function monthlyLedger(load: Record<string, number>, monthlyCapacity: number | null | undefined, fromMonth: string, months = 4): Array<{ month: string; committed: number; capacity: number | null; remaining: number | null }> {
  const cap = monthlyCapacity != null ? Number(monthlyCapacity) : null;
  const [y0, m0] = fromMonth.split('-').map(Number);
  const out = [];
  for (let i = 0; i < months; i++) {
    const idx = (m0 - 1) + i;
    const y = y0 + Math.floor(idx / 12), m = (idx % 12) + 1;
    const key = `${y}-${String(m).padStart(2, '0')}`;
    const committed = load[key] || 0;
    out.push({ month: key, committed, capacity: cap, remaining: cap != null ? cap - committed : null });
  }
  return out;
}
