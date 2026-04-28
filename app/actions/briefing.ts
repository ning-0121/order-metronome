'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import {
  getTodayBriefing as svcGetTodayBriefing,
  getOrGenerateBriefing,
  type BriefingRecord,
} from '@/lib/services/briefing.service';

/**
 * 获取当天简报（兼容旧调用：返回任意时间段最近一份）
 */
export async function getTodayBriefing() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: null, error: '请先登录' };

  const today = new Date().toISOString().slice(0, 10);

  const { data, error } = await (supabase.from('daily_briefings') as any)
    .select('*')
    .eq('user_id', user.id)
    .lte('briefing_date', today)
    .order('briefing_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return { data: null, error: error.message };
  return { data, error: null };
}

// ── 邮件晨报：按需触发 + 缓存 ─────────────────────────────────

/**
 * 仅查今日已有的晨报（不调 AI）
 */
export async function getMyBriefingAction(): Promise<{
  data?: BriefingRecord | null;
  error?: string;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '未登录' };

  const result = await svcGetTodayBriefing(supabase, user.id);
  if (!result.ok) return { error: result.error };
  return { data: result.data };
}

/**
 * 按需生成 / 强制刷新今日晨报（会调 Claude）
 */
export async function generateMyBriefingAction(
  forceRefresh: boolean = false,
): Promise<{ data?: BriefingRecord; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '未登录' };

  const { data: profile } = await (supabase.from('profiles') as any)
    .select('display_name, name')
    .eq('user_id', user.id)
    .single();

  const userName =
    (profile as any)?.display_name ||
    (profile as any)?.name ||
    user.email?.split('@')[0] ||
    '同学';

  const result = await getOrGenerateBriefing(supabase, user.id, {
    forceRefresh,
    userName,
  });

  if (!result.ok) return { error: result.error };

  try { revalidatePath('/ceo'); } catch {}
  try { revalidatePath('/my-today'); } catch {}

  return { data: result.data };
}

/**
 * 确认对照发现
 */
export async function acknowledgeComplianceFinding(findingId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { error } = await (supabase.from('compliance_findings') as any)
    .update({
      status: 'acknowledged',
      resolved_by: user.id,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', findingId);

  return { error: error?.message || null };
}

/**
 * 解决对照发现
 */
export async function resolveComplianceFinding(findingId: string, note: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { error } = await (supabase.from('compliance_findings') as any)
    .update({
      status: 'resolved',
      resolved_by: user.id,
      resolved_at: new Date().toISOString(),
      resolution_note: note,
    })
    .eq('id', findingId);

  return { error: error?.message || null };
}
