import { addDays, format, parseISO, isAfter, startOfDay } from 'date-fns';

// 公司工作制：周一到周六上班，只有周日休息
const isSunday = (d: Date) => d.getDay() === 0;

/**
 * Add working days (skip Sundays only — 6-day work week)
 */
export function addWorkingDays(date: Date, days: number): Date {
  const d = new Date(date);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    if (!isSunday(d)) added++;
  }
  return d;
}

/**
 * Subtract working days (skip Sundays only)
 */
export function subtractWorkingDays(date: Date, days: number): Date {
  const d = new Date(date);
  let removed = 0;
  while (removed < days) {
    d.setDate(d.getDate() - 1);
    if (!isSunday(d)) removed++;
  }
  return d;
}

/**
 * If date falls on Sunday, move to Saturday (previous working day)
 */
export function ensureBusinessDay(date: Date): Date {
  const result = new Date(date);
  if (isSunday(result)) result.setDate(result.getDate() - 1);
  return result;
}

/**
 * If date falls on Sunday, move to Monday (next working day)
 */
export function ensureBusinessDayForward(date: Date): Date {
  const result = new Date(date);
  if (isSunday(result)) result.setDate(result.getDate() + 1);
  return result;
}

/**
 * Format date for display
 */
export function formatDate(date: string | Date, formatStr: string = 'yyyy-MM-dd'): string {
  const dateObj = typeof date === 'string' ? parseISO(date) : date;
  return format(dateObj, formatStr);
}

/**
 * Check if a date is overdue
 */
export function isOverdue(dueDate: string | Date): boolean {
  const due = typeof dueDate === 'string' ? parseISO(dueDate) : dueDate;
  const today = startOfDay(new Date());
  return isAfter(today, startOfDay(due));
}
