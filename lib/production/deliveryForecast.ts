/**
 * 生产排单 P5 —— 交期达成预警(纯函数,零副作用,server/client 共用)。
 * 用 P4 每日实绩推日产速度 → 预测完工日 → 对照交期(factory_date):赶不上就预警,差几天/还差几件。
 * 口径:速度=累计完成 / 首日录产到今天的日历天数(含闲置天,偏保守=早预警)。
 */

function dateOnly(s?: string | null): Date | null {
  if (!s) return null;
  const d = new Date(`${String(s).slice(0, 10)}T00:00:00`);
  return isNaN(d.getTime()) ? null : d;
}
const DAY = 86400000;
function daysBetween(a: Date, b: Date): number { return Math.round((b.getTime() - a.getTime()) / DAY); }
function addDays(base: Date, n: number): string {
  const d = new Date(base.getTime() + n * DAY);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export type ForecastStatus = 'done' | 'onTrack' | 'late' | 'nostart' | 'unknown';
export interface Forecast {
  velocity: number | null;   // 件/天
  remaining: number;         // 还差件数
  etaDays: number | null;    // 还需天数
  etaDate: string | null;    // 预计完工日
  lateDays: number | null;   // 相对交期晚几天(>0=晚;≤0=按时/提前);null=无交期或无法判
  status: ForecastStatus;
}

export function projectFinish(input: {
  planned?: number | null; done?: number | null;
  firstLogDate?: string | null; factoryDate?: string | null; today: string;
}): Forecast {
  const planned = Number(input.planned) || 0;
  const done = Number(input.done) || 0;
  const remaining = Math.max(0, planned - done);
  const empty = (status: ForecastStatus): Forecast => ({ velocity: null, remaining, etaDays: null, etaDate: null, lateDays: null, status });

  if (planned > 0 && done >= planned) return { velocity: null, remaining: 0, etaDays: 0, etaDate: input.today, lateDays: null, status: 'done' };
  if (done <= 0 || !input.firstLogDate) return empty('nostart');
  const first = dateOnly(input.firstLogDate);
  const today = dateOnly(input.today);
  if (!first || !today || today < first) return empty('unknown');
  const elapsed = Math.max(1, daysBetween(first, today) + 1);   // 含首尾
  const velocity = done / elapsed;
  if (velocity <= 0) return empty('unknown');
  const etaDays = Math.ceil(remaining / velocity);
  const etaDate = addDays(today, etaDays);
  let lateDays: number | null = null;
  let status: ForecastStatus = 'onTrack';
  const fd = dateOnly(input.factoryDate);
  if (fd) {
    lateDays = daysBetween(fd, dateOnly(etaDate)!);   // 预计完工 − 交期
    status = lateDays > 0 ? 'late' : 'onTrack';
  }
  return { velocity, remaining, etaDays, etaDate, lateDays, status };
}
