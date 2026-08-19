// 财务同步 outbox 的死信读写(2026-08-19 P1 §10)。判定(谁能重入队)在 action。
import { createServiceRoleClient } from '@/lib/supabase/server';

export async function listDeadOutboxRows(limit = 50): Promise<{ data: any[]; error: string | null }> {
  const svc = createServiceRoleClient();
  const { data, error } = await (svc.from('integration_outbox') as any)
    .select('id, target, event, status, attempts, last_error, created_at')
    .eq('status', 'dead').order('created_at', { ascending: false }).limit(limit);
  if (error) return { data: [], error: error.message };
  return { data: data || [], error: null };
}

/** 死信重新入队:回 pending + attempts 归零 + 立即可重试。CAS(仍为 dead)防重复入队。 */
export async function requeueDeadOutboxRow(id: string): Promise<{ ok?: boolean; error?: string }> {
  const svc = createServiceRoleClient();
  const { data, error } = await (svc.from('integration_outbox') as any)
    .update({ status: 'pending', attempts: 0, next_retry_at: new Date().toISOString(), last_error: null })
    .eq('id', id).eq('status', 'dead').select('id');
  if (error) return { error: error.message };
  if (!data || data.length === 0) return { error: '该条已不是死信(可能已被处理)' };
  return { ok: true };
}
