'use server';

import { createClient } from '@/lib/supabase/server';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import { revalidatePath } from 'next/cache';

/**
 * 报价审批通过（仅 admin 可操作）
 */
export async function approveQuote(orderId: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) {
    return { error: '无权操作：只有管理员可以审批报价' };
  }

  const { error } = await (supabase.from('orders') as any)
    .update({
      quote_status: 'approved',
      quote_approved_by: user.id,
      quote_approved_at: new Date().toISOString(),
    })
    .eq('id', orderId)
    .eq('quote_status', 'pending');

  if (error) return { error: error.message };

  revalidatePath(`/orders/${orderId}`);
  revalidatePath('/orders');
  return {};
}

/**
 * 报价驳回（仅 admin 可操作）
 */
export async function rejectQuote(
  orderId: string,
  reason?: string
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) {
    return { error: '无权操作：只有管理员可以审批报价' };
  }

  const updates: Record<string, unknown> = {
    quote_status: 'rejected',
    quote_approved_by: user.id,
    quote_approved_at: new Date().toISOString(),
  };

  const { error } = await (supabase.from('orders') as any)
    .update(updates)
    .eq('id', orderId)
    .eq('quote_status', 'pending');

  if (error) return { error: error.message };

  revalidatePath(`/orders/${orderId}`);
  revalidatePath('/orders');
  return {};
}
