export type DispatchQueueStatus = 'ready' | 'missing_factory' | 'missing_follow_up' | 'both_missing';

export interface DispatchQueueRowLike {
  factory_id?: string | null;
  factory_name?: string | null;
  production_follow_up_id?: string | null;
}

export function classifyDispatchQueueStatus(row: DispatchQueueRowLike): DispatchQueueStatus {
  const hasFactory = !!String(row.factory_id || row.factory_name || '').trim();
  const hasFollowUp = !!String(row.production_follow_up_id || '').trim();
  if (hasFactory && hasFollowUp) return 'ready';
  if (!hasFactory && !hasFollowUp) return 'both_missing';
  if (!hasFactory) return 'missing_factory';
  return 'missing_follow_up';
}

export function summarizeDispatchQueue(rows: DispatchQueueRowLike[]) {
  const buckets = { total: 0, missing_factory: 0, missing_follow_up: 0, both_missing: 0 };
  for (const row of rows || []) {
    const status = classifyDispatchQueueStatus(row);
    if (status === 'ready') continue;
    buckets.total += 1;
    buckets[status] += 1;
  }
  return buckets;
}
