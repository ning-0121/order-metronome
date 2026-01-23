/**
 * Milestone Domain Helpers
 * 业务逻辑计算函数，不直接操作数据库
 */

import type { MilestoneStatus } from './types';

export interface MilestoneData {
  id: string;
  status: MilestoneStatus;
  due_at: string | null;
  planned_at: string | null;
  notes: string | null;
}

/**
 * 判断里程碑是否超期
 */
export function isMilestoneOverdue(milestone: MilestoneData): boolean {
  if (!milestone.due_at) return false;
  if (milestone.status === '已完成') return false;
  
  const dueDate = new Date(milestone.due_at);
  const now = new Date();
  
  return now > dueDate;
}

/**
 * 判断里程碑是否即将到期（48小时内）
 */
export function isMilestoneDueSoon(milestone: MilestoneData, hoursThreshold: number = 48): boolean {
  if (!milestone.due_at) return false;
  if (milestone.status === '已完成') return false;
  
  const dueDate = new Date(milestone.due_at);
  const now = new Date();
  const diffMs = dueDate.getTime() - now.getTime();
  const diffHours = diffMs / (1000 * 60 * 60);
  
  return diffHours > 0 && diffHours <= hoursThreshold;
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
