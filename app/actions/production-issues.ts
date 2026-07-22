'use server';

/**
 * 生产问题记录(2026-07-22 生产今日工作台 · 第3步)
 * 跟单在跟进中随手记问题 + 设定时提醒;到点由 cron/reminders 提醒 assigned_to。
 * 未解决且到提醒点的问题会进「追踪历史问题」今日待办(daily_tasks prod_issue)。
 * 写入走 user session(RLS auth.uid()),角色用 requireRoleGroup('EXECUTION') 把关。
 */

import { createClient } from '@/lib/supabase/server';
import { requireRoleGroup } from '@/lib/domain/requireRole';
import { friendlyError } from '@/lib/utils/db-error';
import { revalidatePath } from 'next/cache';

const WRITE_MSG = '仅生产/跟单/质检可记录生产问题';

export interface ProductionIssue {
  id: string;
  order_id: string;
  milestone_id: string | null;
  category: string | null;
  title: string;
  description: string | null;
  severity: 'low' | 'normal' | 'high';
  status: 'open' | 'resolved';
  created_by: string | null;
  assigned_to: string | null;
  remind_at: string | null;
  last_reminded_at: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  created_at: string;
  creator_name?: string | null;
  assignee_name?: string | null;
}

export async function createProductionIssue(input: {
  order_id: string;
  title: string;
  description?: string;
  category?: string;
  severity?: 'low' | 'normal' | 'high';
  milestone_id?: string | null;
  assigned_to?: string | null;
  remind_at?: string | null;   // ISO;留空=不定时提醒
}): Promise<{ id?: string; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const err = await requireRoleGroup(supabase, user.id, 'EXECUTION', WRITE_MSG);
  if (err) return { error: err };
  if (!input.order_id) return { error: '缺少订单' };
  if (!input.title?.trim()) return { error: '请填写问题标题' };

  // 默认负责人=记录人(自己盯);remind_at 若在过去则忽略(不做无意义的立即提醒)
  const remindAt = input.remind_at && new Date(input.remind_at).getTime() > Date.now() ? input.remind_at : null;
  const { data, error } = await (supabase.from('production_issues') as any)
    .insert({
      order_id: input.order_id,
      milestone_id: input.milestone_id || null,
      category: input.category || null,
      title: input.title.trim(),
      description: input.description?.trim() || null,
      severity: input.severity || 'normal',
      status: 'open',
      created_by: user.id,
      assigned_to: input.assigned_to || user.id,
      remind_at: remindAt,
    })
    .select('id')
    .single();
  if (error) return { error: friendlyError(error) };
  revalidatePath(`/production/order/${input.order_id}`);
  return { id: (data as any).id };
}

export async function listProductionIssues(opts: {
  order_id?: string;
  status?: 'open' | 'resolved' | 'all';
  mine?: boolean;   // 只看指派给自己的
  limit?: number;
}): Promise<{ data?: ProductionIssue[]; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  let q = (supabase.from('production_issues') as any)
    .select('id, order_id, milestone_id, category, title, description, severity, status, created_by, assigned_to, remind_at, last_reminded_at, resolved_at, resolved_by, resolution_note, created_at')
    .order('created_at', { ascending: false })
    .limit(opts.limit ?? 100);
  if (opts.order_id) q = q.eq('order_id', opts.order_id);
  if (opts.status && opts.status !== 'all') q = q.eq('status', opts.status);
  if (opts.mine) q = q.eq('assigned_to', user.id);
  const { data, error } = await q;
  if (error) return { error: error.message };

  // 补人名(两步查,避免 FK 关联报错)
  const ids = [...new Set((data || []).flatMap((r: any) => [r.created_by, r.assigned_to]).filter(Boolean))];
  let nameMap: Record<string, string> = {};
  if (ids.length) {
    const { data: profs } = await (supabase.from('profiles') as any).select('user_id, name').in('user_id', ids);
    nameMap = (profs || []).reduce((m: any, p: any) => { m[p.user_id] = p.name; return m; }, {});
  }
  const enriched = (data || []).map((r: any) => ({
    ...r,
    creator_name: r.created_by ? nameMap[r.created_by] || null : null,
    assignee_name: r.assigned_to ? nameMap[r.assigned_to] || null : null,
  }));
  return { data: enriched as ProductionIssue[] };
}

export async function resolveProductionIssue(
  id: string,
  resolutionNote?: string,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const err = await requireRoleGroup(supabase, user.id, 'EXECUTION', WRITE_MSG);
  if (err) return { error: err };

  const { data: row } = await (supabase.from('production_issues') as any).select('order_id').eq('id', id).single();
  const { error } = await (supabase.from('production_issues') as any)
    .update({
      status: 'resolved',
      resolved_at: new Date().toISOString(),
      resolved_by: user.id,
      resolution_note: resolutionNote?.trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) return { error: friendlyError(error) };
  if (row?.order_id) revalidatePath(`/production/order/${row.order_id}`);
  return {};
}

/** 改提醒时间(重新排一个定时提醒;传 null 取消提醒)。 */
export async function updateProductionIssueRemind(
  id: string,
  remindAt: string | null,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const err = await requireRoleGroup(supabase, user.id, 'EXECUTION', WRITE_MSG);
  if (err) return { error: err };
  const remind = remindAt && new Date(remindAt).getTime() > Date.now() ? remindAt : null;
  const { error } = await (supabase.from('production_issues') as any)
    .update({ remind_at: remind, last_reminded_at: null, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) return { error: friendlyError(error) };
  return {};
}
