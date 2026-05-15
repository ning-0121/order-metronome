/**
 * Batch-Aware Milestones — 分批出货节点感知
 *
 * 这些里程碑在 order.is_split_shipment=true 时，状态由批次进度推导：
 *   - 所有批次都完成此节点 → 主 milestone = done
 *   - 部分批次完成 → 主 milestone 保持 in_progress，UI 显示 "X/N 批已完成"
 *
 * 非分批订单（is_split_shipment=false）走原流程，本逻辑不参与。
 */

export const BATCH_AWARE_STEP_KEYS = [
  'inspection_release',
  'booking_done',
  'customs_export',
  'finance_shipment_approval',
  'shipment_execute',
] as const;

export type BatchAwareStepKey = typeof BATCH_AWARE_STEP_KEYS[number];

export function isBatchAwareStep(stepKey: string | null | undefined): stepKey is BatchAwareStepKey {
  if (!stepKey) return false;
  return (BATCH_AWARE_STEP_KEYS as readonly string[]).includes(stepKey);
}

/**
 * 每个 batch-aware 节点的元数据
 */
export const BATCH_STEP_META: Record<BatchAwareStepKey, {
  label: string;
  ownerRoleHint: string;
  // 该节点的批次完成度从何处读取
  source: 'milestone_progress' | 'status_shipped';
}> = {
  inspection_release: {
    label: '验货放行',
    ownerRoleHint: 'qc/merchandiser',
    source: 'milestone_progress',
  },
  booking_done: {
    label: '订舱完成',
    ownerRoleHint: 'sales',
    source: 'milestone_progress',
  },
  customs_export: {
    label: '报关安排出运',
    ownerRoleHint: 'sales',
    source: 'milestone_progress',
  },
  finance_shipment_approval: {
    label: '核准出运',
    ownerRoleHint: 'finance',
    source: 'milestone_progress',
  },
  shipment_execute: {
    label: '出运',
    ownerRoleHint: 'logistics',
    source: 'status_shipped',
  },
};

/**
 * 判断单个批次是否已完成给定节点
 *
 * @param batch shipment_batches 行
 * @param stepKey BATCH_AWARE_STEP_KEYS 中的某一项
 */
export function isBatchStepDone(
  batch: { status?: string; actual_ship_date?: string | null; milestone_progress?: Record<string, string | null> | null },
  stepKey: BatchAwareStepKey,
): boolean {
  const meta = BATCH_STEP_META[stepKey];
  if (meta.source === 'status_shipped') {
    return batch.status === 'shipped';
  }
  // milestone_progress 来源
  const progress = batch.milestone_progress ?? {};
  return Boolean(progress[stepKey]);
}

/**
 * 计算指定节点的批次完成度
 * @returns { done: 已完成批次数, total: 总批次数, allDone: 是否全部完成 }
 */
export function computeBatchProgress(
  batches: Array<{ status?: string; actual_ship_date?: string | null; milestone_progress?: Record<string, string | null> | null }>,
  stepKey: BatchAwareStepKey,
): { done: number; total: number; allDone: boolean } {
  const total = batches.length;
  if (total === 0) return { done: 0, total: 0, allDone: false };
  const done = batches.filter(b => isBatchStepDone(b, stepKey)).length;
  return { done, total, allDone: done === total };
}
