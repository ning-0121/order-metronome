/**
 * Execution Bridge — V1.3
 * War Room 根因 → 员工执行任务映射
 * 纯规则，无 LLM
 */
import { isBlockedStatus, isDoneStatus } from '@/lib/domain/types';
export interface ExecutionTask {
  id: string;
  milestoneId: string;
  orderId: string;
  orderNo: string;
  customerName: string;
  milestoneName: string;
  stepKey: string;
  ownerRole: string;
  dueAt: string | null;
  status: string;
  isCritical: boolean;
  evidenceRequired: boolean;
  evidenceNote: string | null;
  /** 任务紧迫级别 */
  urgency: 'OVERDUE' | 'TODAY' | 'UPCOMING';
  /** 来自 War Room 根因（可选） */
  warRoomTag?: string;
  /** 系统建议文案 */
  suggestion: string;
}

const URGENCY_ORDER = { OVERDUE: 0, TODAY: 1, UPCOMING: 2 };

function getUrgency(dueAt: string | null): 'OVERDUE' | 'TODAY' | 'UPCOMING' {
  if (!dueAt) return 'UPCOMING';
  const due = new Date(dueAt);
  const now = new Date();
  const diffH = (due.getTime() - now.getTime()) / 3600000;
  if (diffH < 0) return 'OVERDUE';
  if (diffH <= 24) return 'TODAY';
  return 'UPCOMING';
}

/** 根据 step_key 生成系统建议文案 */
function buildSuggestion(stepKey: string, evidenceNote: string | null, urgency: string): string {
  const base = evidenceNote
    ? `需上传：${evidenceNote}`
    : '请完成本节点并提交处理记录';

  if (urgency === 'OVERDUE') return `⚠️ 节点已逾期，请立即处理。${base}`;
  if (urgency === 'TODAY')   return `📅 今日截止，请在下班前完成。${base}`;
  return `🔔 即将到期（48小时内）。${base}`;
}

