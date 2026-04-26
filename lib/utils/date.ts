import { addDays, format, parseISO, isAfter, startOfDay } from 'date-fns';

/**
 * 中国法定节假日（2025-2027）— 与 lib/schedule.ts 共享逻辑
 * 公司工作制：周一到周六上班，周日+法定节假日休息
 */
const CHINA_HOLIDAYS: Set<string> = new Set([
  // 2025
  '2025-01-01',
  '2025-01-28','2025-01-29','2025-01-30','2025-01-31','2025-02-01',
  '2025-02-02','2025-02-03','2025-02-04',
  '2025-04-04','2025-04-05','2025-04-06',
  '2025-05-01','2025-05-02','2025-05-03','2025-05-04','2025-05-05',
  '2025-05-31','2025-06-01','2025-06-02',
  '2025-10-01','2025-10-02','2025-10-03','2025-10-04',
  '2025-10-05','2025-10-06','2025-10-07','2025-10-08',
  // 2026
  '2026-01-01','2026-01-02','2026-01-03',
  '2026-02-16','2026-02-17','2026-02-18','2026-02-19','2026-02-20',
  '2026-02-21','2026-02-22',
  '2026-04-05','2026-04-06','2026-04-07',
  '2026-05-01','2026-05-02','2026-05-03','2026-05-04','2026-05-05',
  '2026-06-19','2026-06-20','2026-06-21',
  '2026-09-25','2026-09-26','2026-09-27',
  '2026-10-01','2026-10-02','2026-10-03','2026-10-04',
  '2026-10-05','2026-10-06','2026-10-07',
  // 2027
  '2027-01-01','2027-01-02','2027-01-03',
  '2027-02-06','2027-02-07','2027-02-08','2027-02-09','2027-02-10',
  '2027-02-11','2027-02-12',
  '2027-04-05','2027-04-06','2027-04-07',
  '2027-05-01','2027-05-02','2027-05-03','2027-05-04','2027-05-05',
  '2027-06-09','2027-06-10','2027-06-11',
  '2027-09-15','2027-09-16','2027-09-17',
  '2027-10-01','2027-10-02','2027-10-03','2027-10-04',
  '2027-10-05','2027-10-06','2027-10-07',
]);

/**
 * 检查是否为非工作日（周日 + 中国法定节假日）
 *
 * ⚠️ 必须用北京时间解析日期！服务器 TZ 可能是 UTC（Vercel），
 * 直接用 getDay/getFullYear 会把北京的 04-08 误判为 UTC 的 04-07。
 */
function isNonWorkday(d: Date): boolean {
  // 把 UTC 时间 +8h 后用 UTC 方法读取 → 得到北京本地日期
  const bj = new Date(d.getTime() + 8 * 3600 * 1000);
  if (bj.getUTCDay() === 0) return true; // 周日
  const y = bj.getUTCFullYear();
  const m = String(bj.getUTCMonth() + 1).padStart(2, '0');
  const day = String(bj.getUTCDate()).padStart(2, '0');
  return CHINA_HOLIDAYS.has(`${y}-${m}-${day}`);
}

/**
 * Add working days (skip Sundays + Chinese holidays)
 */
export function addWorkingDays(date: Date, days: number): Date {
  const d = new Date(date);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    if (!isNonWorkday(d)) added++;
  }
  return d;
}

/**
 * Subtract working days (skip Sundays + Chinese holidays)
 */
export function subtractWorkingDays(date: Date, days: number): Date {
  const d = new Date(date);
  let removed = 0;
  while (removed < days) {
    d.setDate(d.getDate() - 1);
    if (!isNonWorkday(d)) removed++;
  }
  return d;
}

/**
 * If date falls on non-workday, move to previous working day
 */
export function ensureBusinessDay(date: Date): Date {
  const result = new Date(date);
  while (isNonWorkday(result)) result.setDate(result.getDate() - 1);
  return result;
}

/**
 * If date falls on non-workday, move to next working day
 */
export function ensureBusinessDayForward(date: Date): Date {
  const result = new Date(date);
  while (isNonWorkday(result)) result.setDate(result.getDate() + 1);
  return result;
}

/**
 * Format date for display
 */
export function formatDate(date: string | Date, formatStr: string = 'yyyy-MM-dd'): string {
  try {
    const dateObj = typeof date === 'string' ? parseISO(date) : date;
    if (isNaN(dateObj.getTime())) return '—';
    return format(dateObj, formatStr);
  } catch {
    return '—';
  }
}

/**
 * 完整时间戳：'2026-04-26 14:32'
 * 用于 hover title / 审计日志显示
 */
export function formatDateTime(date: string | Date | null | undefined): string {
  if (!date) return '—';
  return formatDate(date, 'yyyy-MM-dd HH:mm');
}

/**
 * 相对时间：'2 小时前' / '昨天 14:32' / '3 天前' / '2026-04-20'
 * GitHub / Notion 风格的紧凑显示
 *
 * 规则：
 * - <60 秒：刚刚
 * - <60 分钟：N 分钟前
 * - <24 小时：N 小时前
 * - 昨天：昨天 HH:mm
 * - <7 天：N 天前
 * - 更早：完整日期
 */
export function formatRelative(date: string | Date | null | undefined): string {
  if (!date) return '—';
  try {
    const dateObj = typeof date === 'string' ? parseISO(date) : date;
    if (isNaN(dateObj.getTime())) return '—';
    const now = new Date();
    const diffMs = now.getTime() - dateObj.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    if (diffSec < 0) return formatDate(dateObj); // 未来时间，直接显示日期
    if (diffSec < 60) return '刚刚';
    if (diffMin < 60) return `${diffMin} 分钟前`;
    if (diffHour < 24) return `${diffHour} 小时前`;
    if (diffDay === 1) return `昨天 ${format(dateObj, 'HH:mm')}`;
    if (diffDay < 7) return `${diffDay} 天前`;
    return formatDate(dateObj);
  } catch {
    return '—';
  }
}

/**
 * Check if a date is overdue (day-level comparison, Beijing time)
 * 使用 startOfDay 比较，确保当天截止的不算超期
 */
export function isOverdue(dueDate: string | Date): boolean {
  const due = typeof dueDate === 'string' ? parseISO(dueDate) : dueDate;
  if (isNaN(due.getTime())) return false;
  const today = startOfDay(new Date());
  return isAfter(today, startOfDay(due));
}
