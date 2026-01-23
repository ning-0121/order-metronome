import { addDays, addBusinessDays, subBusinessDays, format, parseISO, isWeekend, isAfter, startOfDay } from 'date-fns';

/**
 * Add business days (excluding weekends)
 */
export function addWorkingDays(date: Date, days: number): Date {
  return addBusinessDays(date, days);
}

/**
 * Subtract business days (excluding weekends)
 */
export function subtractWorkingDays(date: Date, days: number): Date {
  return subBusinessDays(date, days);
}

/**
 * Get the previous business day if the date falls on a weekend
 */
export function ensureBusinessDay(date: Date): Date {
  let result = new Date(date);
  while (isWeekend(result)) {
    result = subtractWorkingDays(result, 1);
  }
  return result;
}

/**
 * Get the next business day if the date falls on a weekend
 */
export function ensureBusinessDayForward(date: Date): Date {
  let result = new Date(date);
  while (isWeekend(result)) {
    result = addWorkingDays(result, 1);
  }
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
