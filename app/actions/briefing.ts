'use server';

import { createClient } from '@/lib/supabase/server';

/**
 * 获取当天简报
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
