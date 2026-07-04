'use server';

/**
 * 采购单自定义追踪提醒节点(2026-07-04)—— 采购给每张 PO 加「节点 + 日期」,
 * cron 到点提醒采购 / 业务 / 跟单(见 /api/cron/reminders 的 checkPoReminders)。
 * 采购(含经理)/ 管理员可维护;与该单相关的人可查看。CRUD only,不发通知(通知在 cron)。
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

const MANAGE_ROLES = ['procurement', 'procurement_manager', 'admin'];

async function ctx(): Promise<{ supabase: any; userId?: string; roles: string[]; canManage: boolean; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { supabase, roles: [], canManage: false, error: '请先登录' };
  const { data: profile } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  return { supabase, userId: user.id, roles, canManage: roles.some((r) => MANAGE_ROLES.includes(r)) };
}

export interface PoReminder {
  id: string; purchase_order_id: string; label: string; note: string | null;
  remind_at: string; status: string; notified_at: string | null; done_at: string | null; created_at: string;
}

/** 列出某采购单的提醒节点(按日期升序)。 */
export async function listPoReminders(poId: string): Promise<{ data?: PoReminder[]; error?: string }> {
  const { supabase, error } = await ctx();
  if (error) return { error };
  const { data, error: e } = await (supabase.from('po_reminders') as any)
    .select('*').eq('purchase_order_id', poId).order('remind_at', { ascending: true });
  if (e) {
    if (/relation .*po_reminders.* does not exist|does not exist/i.test(e.message)) return { data: [] }; // 迁移未执行 → 静默空
    return { error: e.message };
  }
  return { data: (data || []) as PoReminder[] };
}

/** 新增提醒节点。 */
export async function addPoReminder(poId: string, input: { label: string; remind_at: string; note?: string }): Promise<{ ok?: boolean; error?: string }> {
  const { supabase, userId, canManage, error } = await ctx();
  if (error) return { error };
  if (!canManage) return { error: '仅采购/管理员可设置提醒' };
  const label = (input.label || '').trim();
  if (!label) return { error: '请填写提醒节点名称' };
  if (!input.remind_at) return { error: '请选择提醒日期' };
  const { error: e } = await (supabase.from('po_reminders') as any).insert({
    purchase_order_id: poId, label, note: (input.note || '').trim() || null,
    remind_at: input.remind_at, status: 'pending', created_by: userId,
  });
  if (e) {
    if (/does not exist/i.test(e.message)) return { error: '提醒功能的数据表尚未创建,请先在 Supabase 执行 20260704_po_reminders.sql' };
    return { error: e.message };
  }
  revalidatePath(`/procurement/po/${poId}`);
  return { ok: true };
}

/** 编辑提醒(改名/改期/改备注)。改期会把已提醒的节点重置回 pending 以便再次到点提醒。 */
export async function updatePoReminder(id: string, patch: { label?: string; remind_at?: string; note?: string }): Promise<{ ok?: boolean; error?: string }> {
  const { supabase, canManage, error } = await ctx();
  if (error) return { error };
  if (!canManage) return { error: '仅采购/管理员可修改提醒' };
  const upd: Record<string, any> = { updated_at: new Date().toISOString() };
  if (patch.label !== undefined) upd.label = patch.label.trim();
  if (patch.note !== undefined) upd.note = patch.note.trim() || null;
  if (patch.remind_at !== undefined) { upd.remind_at = patch.remind_at; upd.status = 'pending'; upd.notified_at = null; }
  const { data, error: e } = await (supabase.from('po_reminders') as any).update(upd).eq('id', id).select('purchase_order_id').maybeSingle();
  if (e) return { error: e.message };
  if ((data as any)?.purchase_order_id) revalidatePath(`/procurement/po/${(data as any).purchase_order_id}`);
  return { ok: true };
}

/** 标记完成(该追踪节点已达成,不再需要盯)。 */
export async function markPoReminderDone(id: string): Promise<{ ok?: boolean; error?: string }> {
  const { supabase, canManage, error } = await ctx();
  if (error) return { error };
  if (!canManage) return { error: '仅采购/管理员可操作' };
  const { data, error: e } = await (supabase.from('po_reminders') as any)
    .update({ status: 'done', done_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id).select('purchase_order_id').maybeSingle();
  if (e) return { error: e.message };
  if ((data as any)?.purchase_order_id) revalidatePath(`/procurement/po/${(data as any).purchase_order_id}`);
  return { ok: true };
}

/** 删除提醒节点。 */
export async function deletePoReminder(id: string): Promise<{ ok?: boolean; error?: string }> {
  const { supabase, canManage, error } = await ctx();
  if (error) return { error };
  if (!canManage) return { error: '仅采购/管理员可删除' };
  const { data } = await (supabase.from('po_reminders') as any).select('purchase_order_id').eq('id', id).maybeSingle();
  const { error: e } = await (supabase.from('po_reminders') as any).delete().eq('id', id);
  if (e) return { error: e.message };
  if ((data as any)?.purchase_order_id) revalidatePath(`/procurement/po/${(data as any).purchase_order_id}`);
  return { ok: true };
}
