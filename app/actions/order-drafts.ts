'use server';

/**
 * 创建订单草稿(2026-07-30):填到一半离开,回来接着填,换设备也能接着填。
 *
 * 与 lib/order/create-order-resilience.ts 的 sessionStorage 草稿分工:
 *   · sessionStorage —— 自动的【崩溃/换版恢复】,同标签页内兜底,用户无感
 *   · 本表 order_drafts —— 用户【显式保存】的草稿,跨设备、可列出、可删
 * 两者共用 SafeOrderDraft 的字段快照结构,恢复复用 restoreSafeOrderDraft,不另写一套。
 *
 * 草稿是私人未完成品:RLS 限定 user_id = auth.uid(),这里不额外做角色门禁
 * (能进创建订单页就能存自己的草稿)。附件/密钥类字段在序列化阶段已排除,不落库。
 *
 * 注意:本文件是 'use server',只能导出 async function(见 pre-deploy 静态闸)。
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

export interface OrderDraftRow {
  id: string;
  label: string | null;
  fieldCount: number;
  updatedAt: string;
  createdAt: string;
}

/** 单用户草稿上限:防止误点存出几百条。超了删最旧的。 */
const MAX_DRAFTS_PER_USER = 20;

/**
 * 保存/更新草稿。传 draftId 则更新那条,否则新建。
 * fields 为 [[name, value], ...](serializeSafeOrderDraft 的产物)。
 */
export async function saveOrderDraft(params: {
  draftId?: string | null;
  label?: string | null;
  fields: Array<[string, string]>;
}): Promise<{ ok?: boolean; draftId?: string; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const fields = Array.isArray(params.fields) ? params.fields : [];
  if (fields.length === 0) return { error: '表单还是空的,没什么可存的。' };

  const label = (params.label || '').trim().slice(0, 120) || null;
  const now = new Date().toISOString();

  if (params.draftId) {
    const { data, error } = await (supabase.from('order_drafts') as any)
      .update({ label, fields, updated_at: now })
      .eq('id', params.draftId).eq('user_id', user.id)   // 只能改自己的(RLS 之外再兜一层)
      .select('id').maybeSingle();
    if (error) return { error: '保存草稿失败:' + error.message };
    if (data) return { ok: true, draftId: (data as any).id };
    // 传了 id 但没命中(已被删)→ 落到下面新建,不让用户白填
  }

  const { data: created, error: insErr } = await (supabase.from('order_drafts') as any)
    .insert({ user_id: user.id, label, fields, created_at: now, updated_at: now })
    .select('id').single();
  if (insErr) return { error: '保存草稿失败:' + insErr.message };

  // 超上限 → 清理最旧的(只动自己的)
  const { data: extras } = await (supabase.from('order_drafts') as any)
    .select('id').eq('user_id', user.id).order('updated_at', { ascending: false })
    .range(MAX_DRAFTS_PER_USER, MAX_DRAFTS_PER_USER + 99);
  const stale = ((extras || []) as any[]).map((r) => r.id);
  if (stale.length > 0) {
    await (supabase.from('order_drafts') as any).delete().eq('user_id', user.id).in('id', stale);
  }

  revalidatePath('/orders/new');
  return { ok: true, draftId: (created as any).id };
}

/** 我的草稿列表(最近更新在前)。 */
export async function listMyOrderDrafts(): Promise<{ data?: OrderDraftRow[]; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data, error } = await (supabase.from('order_drafts') as any)
    .select('id, label, fields, created_at, updated_at')
    .eq('user_id', user.id).order('updated_at', { ascending: false }).limit(MAX_DRAFTS_PER_USER);
  if (error) {
    // 迁移未执行 → 当作"没有草稿",不让创建订单页因此崩掉
    if (/order_drafts|does not exist|schema cache/i.test(error.message || '')) return { data: [] };
    return { error: error.message };
  }
  return {
    data: ((data || []) as any[]).map((r) => ({
      id: r.id,
      label: r.label,
      fieldCount: Array.isArray(r.fields) ? r.fields.length : 0,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  };
}

/** 取一条草稿的完整字段,用于回填表单。 */
export async function getOrderDraft(draftId: string): Promise<{
  data?: { id: string; label: string | null; fields: Array<[string, string]>; updatedAt: string };
  error?: string;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data, error } = await (supabase.from('order_drafts') as any)
    .select('id, label, fields, updated_at').eq('id', draftId).eq('user_id', user.id).maybeSingle();
  if (error) return { error: error.message };
  if (!data) return { error: '草稿不存在或已删除' };

  const raw = (data as any).fields;
  const fields = (Array.isArray(raw) ? raw : []).filter(
    (p: any) => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && typeof p[1] === 'string',
  ) as Array<[string, string]>;
  return { data: { id: (data as any).id, label: (data as any).label, fields, updatedAt: (data as any).updated_at } };
}

/** 删除草稿(下单成功后 / 用户手动丢弃)。 */
export async function deleteOrderDraft(draftId: string): Promise<{ ok?: boolean; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { error } = await (supabase.from('order_drafts') as any)
    .delete().eq('id', draftId).eq('user_id', user.id);
  if (error) return { error: error.message };
  revalidatePath('/orders/new');
  return { ok: true };
}
