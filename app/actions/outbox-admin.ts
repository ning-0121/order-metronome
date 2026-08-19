'use server';

/**
 * 财务同步死信管理(2026-08-19 P1 §10)。仅 admin。
 * requeue = status 回 pending + attempts 归零 + next_retry_at 置现在,交给既有 cron 重试通道;
 * 不在此直接重发(重发逻辑只有一份,在 finance-sync/cron)。
 */
import { createClient } from '@/lib/supabase/server';
import { getUserRoles } from '@/lib/utils/user-role';
import { listDeadOutboxRows, requeueDeadOutboxRow } from '@/lib/repositories/integrationOutboxRepo';

async function requireAdmin(): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: '请先登录' };
  const roles = await getUserRoles(supabase, user.id);
  if (!roles.includes('admin')) return { ok: false, error: '仅管理员可管理同步死信' };
  return { ok: true };
}

export async function listDeadOutbox(): Promise<{ data?: any[]; error?: string }> {
  const g = await requireAdmin();
  if (!g.ok) return { error: g.error };
  const { data, error } = await listDeadOutboxRows(50);
  if (error) return { error };
  return { data };
}

export async function requeueDeadOutbox(id: string): Promise<{ ok?: boolean; error?: string }> {
  const g = await requireAdmin();
  if (!g.ok) return { error: g.error };
  return requeueDeadOutboxRow(id);
}
