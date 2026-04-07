'use server';

import { createClient } from '@/lib/supabase/server';
import { getCurrentUserRole } from '@/lib/utils/user-role';

/**
 * 邮件无声失败监控（管理员用）
 *
 * 找出"被吞掉"的邮件 — 即客户未识别 / 订单未匹配的邮件，
 * 这些邮件不会触发任何通知，业务员看不到。
 */
export async function getSilentFailureMails(daysBack: number = 7) {
  const supabase = await createClient();
  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { error: '仅管理员可查看', data: null };

  const since = new Date(Date.now() - daysBack * 86400000).toISOString();

  const { data, error } = await (supabase.from('mail_inbox') as any)
    .select('id, from_email, subject, received_at, processing_status, customer_id, order_id, last_processed_at')
    .in('processing_status', ['unmatched', 'matched_customer', 'parse_failed'])
    .gte('received_at', since)
    .order('received_at', { ascending: false })
    .limit(200);

  if (error) return { error: error.message, data: null };

  // 按状态分组统计
  const stats = {
    unmatched: 0,
    matched_customer: 0,
    parse_failed: 0,
  };
  for (const r of data || []) {
    const k = r.processing_status as keyof typeof stats;
    if (k in stats) stats[k]++;
  }

  return { data: { mails: data || [], stats }, error: null };
}

/**
 * 标记一封邮件为"已人工处理"
 */
export async function markMailHandled(mailId: string) {
  const supabase = await createClient();
  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { error: '仅管理员可操作' };

  const { error } = await (supabase.from('mail_inbox') as any)
    .update({ processing_status: 'skipped', last_processed_at: new Date().toISOString() })
    .eq('id', mailId);

  if (error) return { error: error.message };
  return { error: null };
}

/**
 * 获取某个订单的邮件差异列表（订单详情页用）
 */
export async function getOrderEmailDiffs(orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录', data: null };

  const { data, error } = await (supabase.from('email_order_diffs') as any)
    .select('id, mail_inbox_id, field, email_value, order_value, severity, suggestion, status, detected_at, resolved_at, resolution_note')
    .eq('order_id', orderId)
    .order('detected_at', { ascending: false })
    .limit(50);

  if (error) return { error: error.message, data: null };
  return { data: data || [], error: null };
}

/**
 * 标记差异为已解决 / 已忽略 / 误报
 */
export async function resolveEmailDiff(
  diffId: string,
  status: 'resolved' | 'ignored' | 'false_positive',
  note?: string,
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { error } = await (supabase.from('email_order_diffs') as any)
    .update({
      status,
      resolved_by: user.id,
      resolved_at: new Date().toISOString(),
      resolution_note: note || null,
    })
    .eq('id', diffId);

  if (error) return { error: error.message };
  return { error: null };
}
