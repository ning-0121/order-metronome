/**
 * Execution Bridge — V1.3
 * War Room 根因 → 员工执行任务映射
 * 纯规则，无 LLM
 */
import { isDoneStatus } from '@/lib/domain/types';

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

/**
 * 将里程碑数据映射为员工执行任务
 * @param milestones 该用户角色的里程碑（已过滤 owner_role）
 * @param warRoomRootNodes War Room 识别的根因节点名列表（可选）
 */
export function buildExecutionTasks(
  milestones: any[],
  orders: Record<string, { order_no: string; customer_name: string }>,
  warRoomRootNodes: string[] = []
): ExecutionTask[] {
  const now = new Date();
  const in48h = new Date(now.getTime() + 48 * 3600000);

  const tasks: ExecutionTask[] = [];

  for (const m of milestones) {
    if (isDoneStatus(m.status)) continue;

    const due = m.due_at ? new Date(m.due_at) : null;
    const urgency = getUrgency(m.due_at);

    // 只收录：逾期 + 今日到期 + 48h内到期
    if (due && due > in48h) continue;
    // 无截止日期的节点：只收录阻塞状态
    if (!due && m.status !== '阻塞') continue;

    const order = orders[m.order_id];
    if (!order) continue;

    const isWarRoomRoot = warRoomRootNodes.includes(m.name);

    tasks.push({
      id: m.id,
      milestoneId: m.id,
      orderId: m.order_id,
      orderNo: order.order_no,
      customerName: order.customer_name,
      milestoneName: m.name,
      stepKey: m.step_key,
      ownerRole: m.owner_role,
      dueAt: m.due_at,
      status: m.status,
      isCritical: m.is_critical,
      evidenceRequired: m.evidence_required,
      evidenceNote: m.evidence_note || null,
      urgency,
      warRoomTag: isWarRoomRoot ? '⚔️ War Room 根因节点' : undefined,
      suggestion: buildSuggestion(m.step_key, m.evidence_note, urgency),
    });
  }

  // 排序：War Room 根因 > OVERDUE > TODAY > UPCOMING，同级按 due_at 升序
  return tasks.sort((a, b) => {
    const aWr = a.warRoomTag ? -1 : 0;
    const bWr = b.warRoomTag ? -1 : 0;
    if (aWr !== bWr) return aWr - bWr;
    const urgencyDiff = URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency];
    if (urgencyDiff !== 0) return urgencyDiff;
    if (!a.dueAt && !b.dueAt) return 0;
    if (!a.dueAt) return 1;
    if (!b.dueAt) return -1;
    return new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
  });
}

/** 统计执行任务摘要 */
export function summarizeExecutionTasks(tasks: ExecutionTask[]): {
  overdue: number;
  today: number;
  upcoming: number;
  warRoomLinked: number;
  critical: number;
} {
  return {
    overdue:       tasks.filter(t => t.urgency === 'OVERDUE').length,
    today:         tasks.filter(t => t.urgency === 'TODAY').length,
    upcoming:      tasks.filter(t => t.urgency === 'UPCOMING').length,
    warRoomLinked: tasks.filter(t => !!t.warRoomTag).length,
    critical:      tasks.filter(t => t.isCritical).length,
  };
}
