import { checkAndSendReminders, checkDeliveryDeadlines, checkLinkedMemoReminders } from '@/app/actions/notifications';
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export async function GET(request: Request) {
  // Verify cron secret if needed
  const authHeader = request.headers.get('authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const [reminderResult, deliveryResult, memoReminderResult] = await Promise.all([
      checkAndSendReminders(),
      checkDeliveryDeadlines(),
      checkLinkedMemoReminders(),
    ]);

    // ── 跟单未指定 24h 升级检查 ──
    // CEO 2026-04-09：新订单第二天还没指定跟单 → 再次提醒生产主管 + 上报 CEO
    let escalated = 0;
    try {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (url && key) {
        const supabase = createClient(url, key);
        escalated = await checkUnassignedMerchandiser(supabase);
      }
    } catch (e: any) {
      console.error('[reminders] unassigned merchandiser check error:', e?.message);
    }

    return NextResponse.json({
      success: true,
      reminders: reminderResult,
      delivery_alerts: deliveryResult,
      memo_reminders: memoReminderResult,
      merchandiser_escalated: escalated,
    });
  } catch (error: any) {
    console.error('Cron job error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * 检查创建超过 24h 但跟单仍未指定的订单 → 通知生产主管 + CEO
 *
 * 去重：每单只上报一次（用 notification type='merchandiser_escalation' + order_id 去重）
 */
async function checkUnassignedMerchandiser(supabase: any): Promise<number> {
  const now = Date.now();
  const oneDayAgo = new Date(now - 24 * 3600000).toISOString();
  const threeDaysAgo = new Date(now - 72 * 3600000).toISOString();

  // 找创建 24h-72h 内的活跃订单
  const { data: orders } = await supabase
    .from('orders')
    .select('id, order_no, customer_name, quantity, created_at')
    .gt('created_at', threeDaysAgo)
    .lt('created_at', oneDayAgo)
    .not('lifecycle_status', 'in', '("completed","cancelled","archived","已完成","已取消","已归档")');

  if (!orders || orders.length === 0) return 0;

  let escalatedCount = 0;
  for (const order of orders as any[]) {
    // 检查该订单的 merchandiser 节点是否有 owner_user_id
    const { data: merchMs } = await supabase
      .from('milestones')
      .select('id, owner_user_id')
      .eq('order_id', order.id)
      .eq('owner_role', 'merchandiser')
      .is('owner_user_id', null)
      .limit(1);

    if (!merchMs || merchMs.length === 0) continue; // 已分配，跳过

    // 去重：这个订单是否已上报过
    const { data: existing } = await supabase
      .from('notifications')
      .select('id')
      .eq('type', 'merchandiser_escalation')
      .eq('related_order_id', order.id)
      .limit(1);
    if (existing && existing.length > 0) continue; // 已上报，跳过

    // 找生产主管和 admin
    const { data: pmProfiles } = await supabase
      .from('profiles')
      .select('user_id, roles, role')
      .or('roles.cs.{production_manager},roles.cs.{admin},role.eq.admin');

    const recipients: string[] = [];
    for (const p of (pmProfiles || []) as any[]) {
      const roles: string[] = Array.isArray(p.roles) && p.roles.length > 0 ? p.roles : [p.role].filter(Boolean);
      if (roles.includes('production_manager') || roles.includes('admin')) {
        recipients.push(p.user_id);
      }
    }

    // 给每个人发通知
    for (const userId of recipients) {
      await supabase.from('notifications').insert({
        user_id: userId,
        type: 'merchandiser_escalation',
        title: `🚨 ${order.order_no} 超过 24h 仍未指定跟单！`,
        message:
          `客户 ${order.customer_name || '?'} · ${order.quantity || '?'} 件\n` +
          `创建于 ${new Date(order.created_at).toLocaleString('zh-CN')}\n` +
          `请立即在订单详情页指定跟单人员，避免延误。`,
        related_order_id: order.id,
        status: 'unread',
      });
    }

    // 微信推送
    try {
      const { pushToUsers } = await import('@/lib/utils/wechat-push');
      await pushToUsers(supabase, recipients,
        `🚨 ${order.order_no} 超 24h 无跟单`,
        `客户 ${order.customer_name || '?'}，${order.quantity || '?'} 件\n创建超过 24 小时仍未指定跟单人员！`
      );
    } catch {}

    escalatedCount++;
  }

  return escalatedCount;
}
