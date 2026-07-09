/**
 * Milestone Domain Helpers
 * 业务逻辑计算函数，不直接操作数据库
 */

import { normalizeMilestoneStatus } from './types';
import type { MilestoneStatus } from './types';

export interface MilestoneData {
  id: string;
  status: MilestoneStatus;
  due_at: string | null;
  planned_at: string | null;
  actual_at: string | null;
  notes: string | null;
}

/** 交期预警等级 */
export type DeliveryAlertLevel = 'GREEN' | 'YELLOW' | 'RED';

/**
 * 计算交期预警等级
 * GREEN: actual_at <= due_at 或未填
 * YELLOW: actual_at 超 due_at 1-3 天
 * RED: actual_at 超 due_at >3 天（交期风险）
 */
export function computeDeliveryAlert(actualAt: string | null, dueAt: string | null): DeliveryAlertLevel {
  if (!actualAt || !dueAt) return 'GREEN';
  const diffMs = new Date(actualAt).getTime() - new Date(dueAt).getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays <= 0) return 'GREEN';
  if (diffDays <= 3) return 'YELLOW';
  return 'RED';
}

/**
 * 是否在「3 天补登宽限」内完成
 *
 * 业务定义（2026-05-19）：员工在外勤/车间没及时操作，事后补登 actual_at 的场景
 * 视为「按时完成」如果 actual_at ≤ due_at + 3 天。
 *
 * 用途：
 *   - 历史业绩统计：在宽限内完成 = on-time（不计逾期）
 *   - UI 显示「✓ 准时（含 3 天宽限）」徽章
 *
 * 与 computeDeliveryAlert 的区别：
 *   - computeDeliveryAlert 给三色（GREEN / YELLOW / RED）— 用于「预警」场景
 *   - completedWithinGrace 给布尔（是否算准时）— 用于「事后定性」场景
 *   - YELLOW（1-3 天延迟）在「事后定性」时算 ✓ 准时，在「事中预警」时仍算黄灯
 */
export const BACKFILL_GRACE_DAYS = 3;
export function completedWithinGrace(
  actualAt: string | null,
  dueAt: string | null,
  graceDays: number = BACKFILL_GRACE_DAYS,
): boolean {
  if (!actualAt || !dueAt) return true; // 没填的不当迟到
  const diffDays = computeDelayDays(actualAt, dueAt);
  return diffDays <= graceDays;
}

/**
 * 计算实际日期与截止日期的偏差天数（按北京日历日）
 * 正数=延迟，负数=提前
 *
 * ⚠️ 必须按"日历日"算不能按"毫秒差"，否则 04-08 10:00 完成、04-07 20:00 截止
 * 会被 Math.ceil(14h/24h) 算成 1 天差 + 1 = 2 天，但实际是 1 天。
 */
export function computeDelayDays(actualAt: string | null, dueAt: string | null): number {
  if (!actualAt || !dueAt) return 0;
  // 把时间戳转成北京日期 YYYY-MM-DD，再按日历日差计算
  const toBjDate = (iso: string): Date => {
    const d = new Date(iso);
    const bj = new Date(d.getTime() + 8 * 3600 * 1000);
    // 截断到 UTC 的 00:00 — 此时 UTC 日期就是北京日期
    return new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()));
  };
  const actualDay = toBjDate(actualAt);
  const dueDay = toBjDate(dueAt);
  return Math.round((actualDay.getTime() - dueDay.getTime()) / 86400000);
}

/**
 * 判断里程碑是否超期
 * 统一使用 normalizeMilestoneStatus 进行状态标准化
 */
export function isMilestoneOverdue(milestone: MilestoneData): boolean {
  if (!milestone.due_at) return false;
  const normalized = normalizeMilestoneStatus(milestone.status);
  // 只有「进行中」和「阻塞」才算逾期；未开始/已完成不算
  if (normalized !== '进行中' && normalized !== '阻塞') return false;

  const dueDate = new Date(milestone.due_at);
  const now = new Date();

  return now > dueDate;
}

/**
 * 从 notes 中提取卡住原因
 * 格式：如果 notes 以 "卡住原因：" 开头，提取原因部分
 */
export function extractBlockedReason(notes: string | null): string | null {
  if (!notes) return null;
  
  const prefix = '卡住原因：';
  if (notes.startsWith(prefix)) {
    return notes.substring(prefix.length).trim();
  }
  
  // 如果状态是卡住但没有前缀，返回整个 notes
  return notes.trim() || null;
}

/**
 * 格式化卡住原因到 notes
 * 如果 notes 已有内容且不是卡住原因，则追加
 */
export function formatBlockedReasonToNotes(
  reason: string,
  existingNotes: string | null = null,
  append: boolean = false
): string {
  const prefix = '卡住原因：';
  const formattedReason = `${prefix}${reason.trim()}`;
  
  if (!existingNotes || !existingNotes.trim()) {
    return formattedReason;
  }
  
  if (append) {
    // 追加模式：保留原有内容，追加新原因
    return `${existingNotes}\n\n${formattedReason}`;
  }
  
  // 如果已有卡住原因，替换；否则追加
  if (existingNotes.startsWith(prefix)) {
    return formattedReason;
  }
  
  return `${existingNotes}\n\n${formattedReason}`;
}

/**
 * 追加 notes（用于日志记录）
 */
export function appendToNotes(
  existingNotes: string | null,
  newContent: string,
  timestamp: boolean = true
): string {
  const now = new Date().toISOString();
  const timestampStr = timestamp ? `[${now}] ` : '';
  const newLine = `${timestampStr}${newContent}`;
  
  if (!existingNotes || !existingNotes.trim()) {
    return newLine;
  }
  
  return `${existingNotes}\n${newLine}`;
}
