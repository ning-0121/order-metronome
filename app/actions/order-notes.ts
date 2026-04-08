'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

export interface OrderNote {
  id: string;
  order_id: string;
  author_user_id: string | null;
  author_name: string | null;
  content: string;
  category: 'general' | 'delay' | 'quality' | 'customer' | 'internal' | 'other';
  related_milestone_id: string | null;
  created_at: string;
}

/**
 * 获取订单所有备注日志
 */
export async function getOrderNotes(orderId: string): Promise<{ data?: OrderNote[]; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data, error } = await (supabase.from('order_notes_log') as any)
    .select('*')
    .eq('order_id', orderId)
    .order('created_at', { ascending: false });

  if (error) return { error: error.message };
  return { data: (data || []) as OrderNote[] };
}

/**
 * 添加订单备注
 * 权限：所有登录用户都可以给自己参与的订单加备注
 */
export async function addOrderNote(
  orderId: string,
  content: string,
  category: OrderNote['category'] = 'general',
  relatedMilestoneId?: string,
): Promise<{ error?: string; data?: OrderNote }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const trimmed = content.trim();
  if (!trimmed) return { error: '备注内容不能为空' };
  if (trimmed.length > 2000) return { error: '备注内容过长（最多 2000 字）' };

  // 拿作者名字
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('name, email')
    .eq('user_id', user.id)
    .single();
  const authorName =
    (profile as any)?.name || (profile as any)?.email?.split('@')[0] || '未知';

  const { data, error } = await (supabase.from('order_notes_log') as any)
    .insert({
      order_id: orderId,
      author_user_id: user.id,
      author_name: authorName,
      content: trimmed,
      category,
      related_milestone_id: relatedMilestoneId || null,
    })
    .select('*')
    .single();

  if (error) return { error: error.message };

  revalidatePath(`/orders/${orderId}`);
  return { data: data as OrderNote };
}

/**
 * 删除订单备注
 * 权限：作者本人 / 管理员
 */
export async function deleteOrderNote(
  noteId: string,
  orderId: string,
): Promise<{ error?: string; success?: boolean }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { error } = await (supabase.from('order_notes_log') as any)
    .delete()
    .eq('id', noteId);

  if (error) return { error: error.message };

  revalidatePath(`/orders/${orderId}`);
  return { success: true };
}
