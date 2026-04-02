'use server';

import { createClient } from '@/lib/supabase/server';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import { revalidatePath } from 'next/cache';

/**
 * 提交订单修改申请
 */
export async function submitOrderAmendment(
  orderId: string,
  fields: Record<string, { from: string; to: string }>, // e.g. { quantity: { from: '1000', to: '1500' } }
  reason: string
): Promise<{ error?: string; success?: boolean }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  if (!reason || reason.trim().length < 5) {
    return { error: '请填写修改原因（至少5个字）' };
  }

  if (Object.keys(fields).length === 0) {
    return { error: '请至少选择一项需要修改的内容' };
  }

  const { error } = await (supabase.from('order_amendments') as any).insert({
    order_id: orderId,
    requested_by: user.id,
    fields_to_change: fields,
    reason: reason.trim(),
    status: 'pending', // pending → approved / rejected
  });

  if (error) {
    // 如果表不存在，给出友好提示
    if (error.message?.includes('does not exist') || error.code === '42P01') {
      return { error: '修改申请功能正在初始化，请联系管理员' };
    }
    return { error: '提交失败：' + error.message };
  }

  revalidatePath(`/orders/${orderId}`);
  return { success: true };
}

/**
 * 管理员审批修改申请
 */
export async function approveOrderAmendment(
  amendmentId: string,
  approved: boolean,
  adminNote?: string
): Promise<{ error?: string; success?: boolean }> {
  const supabase = await createClient();
  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { error: '仅管理员可审批' };

  const { data: { user } } = await supabase.auth.getUser();

  const { data: amendment, error: fetchErr } = await (supabase.from('order_amendments') as any)
    .select('*')
    .eq('id', amendmentId)
    .single();

  if (fetchErr || !amendment) return { error: '申请不存在' };
  if (amendment.status !== 'pending') return { error: '此申请已处理' };

  // 更新申请状态
  await (supabase.from('order_amendments') as any)
    .update({
      status: approved ? 'approved' : 'rejected',
      reviewed_by: user!.id,
      reviewed_at: new Date().toISOString(),
      admin_note: adminNote || null,
    })
    .eq('id', amendmentId);

  // 如果批准，自动应用修改到订单
  if (approved && amendment.fields_to_change) {
    const updates: Record<string, string> = {};
    for (const [field, change] of Object.entries(amendment.fields_to_change as Record<string, { to: string }>)) {
      updates[field] = change.to;
    }
    if (Object.keys(updates).length > 0) {
      await (supabase.from('orders') as any)
        .update(updates)
        .eq('id', amendment.order_id);
    }
  }

  revalidatePath(`/orders/${amendment.order_id}`);
  return { success: true };
}

/**
 * 获取订单的修改申请列表
 */
export async function getOrderAmendments(orderId: string) {
  const supabase = await createClient();
  const { data, error } = await (supabase.from('order_amendments') as any)
    .select('*, requester:profiles!order_amendments_requested_by_fkey(name, email), reviewer:profiles!order_amendments_reviewed_by_fkey(name)')
    .eq('order_id', orderId)
    .order('created_at', { ascending: false });

  if (error) {
    // Table might not exist yet
    return { data: [], error: null };
  }
  return { data: data || [], error: null };
}

/**
 * 获取所有待审批的修改申请（管理员用）
 */
export async function getPendingAmendments() {
  const supabase = await createClient();
  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { data: [], error: '无权限' };

  const { data, error } = await (supabase.from('order_amendments') as any)
    .select('*, orders(order_no, customer_name, internal_order_no), requester:profiles!order_amendments_requested_by_fkey(name, email)')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  if (error) return { data: [], error: null };
  return { data: data || [], error: null };
}
