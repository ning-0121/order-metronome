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
 * 获取当前用户的今日邮件晨报
 *
 * 优先级：
 *  1. 今日已生成的晨报（cron 凌晨跑过）→ 直接返回
 *  2. 当日还没生成 → 兜底用昨日的（或返回 null 让 UI 提示尚未生成）
 */
export async function getTodayMorningBriefing(): Promise<{ data?: any; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const today = new Date().toISOString().slice(0, 10);

  // 取最近 2 天内的最新一份晨报
  const { data, error } = await (supabase.from('daily_briefings') as any)
    .select('briefing_date, content, summary_text, total_emails, urgent_count, compliance_count')
    .eq('user_id', user.id)
    .lte('briefing_date', today)
    .gte('briefing_date', new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10))
    .order('briefing_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return { error: error.message };
  if (!data) return { error: '暂无晨报 — cron 还未生成今日内容（每日凌晨 00:00 北京时间生成）' };

  // content 是 jsonb，里面 morning_email 才是晨报内容
  const content = (data as any).content || {};
  const morningEmail = content.morning_email;
  if (!morningEmail) {
    return { error: '今日晨报正在生成中，请稍后刷新' };
  }

  return {
    data: {
      briefingDate: (data as any).briefing_date,
      ...morningEmail,
    },
  };
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
