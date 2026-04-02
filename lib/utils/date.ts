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

/** 检查是否为非工作日（周日 + 中国法定节假日） */
function isNonWorkday(d: Date): boolean {
  if (d.getDay() === 0) return true; // 周日
  // 转北京时间日期字符串
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
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
 * Check if a date is overdue (day-level comparison, Beijing time)
 * 使用 startOfDay 比较，确保当天截止的不算超期
 */
export function isOverdue(dueDate: string | Date): boolean {
  const due = typeof dueDate === 'string' ? parseISO(dueDate) : dueDate;
  if (isNaN(due.getTime())) return false;
  const today = startOfDay(new Date());
  return isAfter(today, startOfDay(due));
}
