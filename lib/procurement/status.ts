// ============================================================
// Procurement view — 生产/采购状态派生（纯函数，无 DB）
// milestone_status 真实枚举：pending | in_progress | done | blocked | overdue
// ============================================================

import type { ProductionStageSummary, ProductionStatus } from './types';

export interface MilestoneInput {
  step_key: string;
  name: string;
  status: string; // 期望 milestone_status 枚举值
  sequence_number: number;
}

/** 由订单的里程碑集合派生「当前生产阶段 + 整体状态摘要」。 */
export function deriveProductionStatus(milestones: MilestoneInput[]): ProductionStageSummary {
  const sorted = [...milestones].sort((a, b) => a.sequence_number - b.sequence_number);
  const total = sorted.length;
  const completed = sorted.filter((m) => m.status === 'done').length;
  const inProgress = sorted.filter((m) => m.status === 'in_progress').length;
  const blocked = sorted.filter((m) => m.status === 'blocked').length;
  const overdue = sorted.filter((m) => m.status === 'overdue').length;

  let overall: ProductionStatus;
  if (total === 0) overall = 'pending';
  else if (overdue > 0) overall = 'overdue';
  else if (blocked > 0) overall = 'blocked';
  else if (completed === total) overall = 'done';
  else if (inProgress > 0 || completed > 0) overall = 'in_progress';
  else overall = 'pending';

  // 当前阶段 = 第一个未完成（非 done）的里程碑（按 sequence）
  const current = sorted.find((m) => m.status !== 'done') ?? null;

  return {
    overall,
    current_step_key: current?.step_key ?? null,
    current_step_name: current?.name ?? null,
    total,
    completed,
    in_progress: inProgress,
    blocked,
    overdue,
  };
}
