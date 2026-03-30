'use server';

import { createClient } from '@/lib/supabase/server';

/**
 * 获取当前用户未读通知
 */
export async function getUnreadNotifications() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: [] };

  const { data, error } = await (supabase
    .from('notifications') as any)
    .select('id, type, title, message, related_order_id, related_milestone_id, status, created_at')
    .eq('user_id', user.id)
    .eq('status', 'unread')
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    console.error('[notifications] 查询失败:', error.message);
    return { data: [] };
  }

  return { data: data || [] };
}

/**
 * 标记通知为已读
 */
export async function markNotificationRead(notificationId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  await (supabase.from('notifications') as any)
    .update({ status: 'read' })
    .eq('id', notificationId)
    .eq('user_id', user.id);
}

/**
 * 标记所有通知为已读
 */
export async function markAllNotificationsRead() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  await (supabase.from('notifications') as any)
    .update({ status: 'read' })
    .eq('user_id', user.id)
    .eq('status', 'unread');
}
