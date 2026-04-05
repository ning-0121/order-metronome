/**
 * Agent 每日工作摘要 — 每天早上 8:30 推送
 *
 * 内容：今日到期节点、超期订单、昨日完成、本周风险预测
 * 推送：邮件 + 微信（管理员 + 行政督办）
 *
 * Vercel Cron: "30 0 * * *" (UTC 00:30 = 北京 08:30)
 */

import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export const maxDuration = 30;

export async function POST(req: Request) {
  try {
    const authHeader = req.headers.get('authorization');
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) return NextResponse.json({ error: 'Missing config' }, { status: 500 });

    const supabase = createClient(url, serviceKey);
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    // 1. 今日到期节点
    const { data: todayDue } = await supabase
      .from('milestones')
      .select('name, owner_role, orders!inner(order_no, customer_name)')
      .gte('due_at', today + 'T00:00:00')
      .lt('due_at', tomorrow + 'T00:00:00')
      .not('status', 'in', '("done","已完成")');

    // 2. 当前超期节点
    const { data: overdue } = await supabase
      .from('milestones')
      .select('name, due_at, owner_role, orders!inner(order_no, customer_name)')
      .in('status', ['in_progress', '进行中'])
      .lt('due_at', today + 'T00:00:00');

    // 3. 昨日完成
    const { data: yesterdayDone } = await supabase
      .from('milestone_logs')
      .select('note, milestones!inner(name, orders!inner(order_no))')
      .eq('action', 'mark_done')
      .gte('created_at', yesterday + 'T00:00:00')
      .lt('created_at', today + 'T00:00:00');

    // 4. 活跃订单数
    const { count: activeCount } = await supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .in('lifecycle_status', ['执行中', 'running', 'active', '已生效']);

    // 5. Agent 昨日执行数
    const { count: agentActions } = await supabase
      .from('agent_actions')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'executed')
      .gte('executed_at', yesterday + 'T00:00:00');

    // 构建摘要
    const lines: string[] = [];
    lines.push(`📊 **每日摘要** — ${today}`);
    lines.push('');
    lines.push(`📦 活跃订单：${activeCount || 0} 个`);
    lines.push(`🔴 超期节点：${(overdue || []).length} 个`);
    lines.push(`📅 今日到期：${(todayDue || []).length} 个`);
    lines.push(`✅ 昨日完成：${(yesterdayDone || []).length} 个`);
    lines.push(`🤖 Agent 昨日执行：${agentActions || 0} 次`);

    if ((overdue || []).length > 0) {
      lines.push('');
      lines.push('**超期订单：**');
      const overdueByOrder = new Map<string, string[]>();
      for (const m of overdue || []) {
        const orderNo = (m as any).orders?.order_no || '未知';
        const list = overdueByOrder.get(orderNo) || [];
        list.push(m.name);
        overdueByOrder.set(orderNo, list);
      }
      for (const [orderNo, nodes] of overdueByOrder) {
        lines.push(`- ${orderNo}：${nodes.join('、')}`);
      }
    }

    if ((todayDue || []).length > 0) {
      lines.push('');
      lines.push('**今日到期：**');
      for (const m of (todayDue || []).slice(0, 8)) {
        lines.push(`- ${(m as any).orders?.order_no} — ${m.name}`);
      }
    }

    const summaryText = lines.join('\n');

    // 推送给管理员和行政
    const { data: admins } = await supabase
      .from('profiles')
      .select('user_id, email, wechat_push_key, roles, role')
      .or("role.eq.admin,roles.cs.{admin},roles.cs.{admin_assistant}");

    // 发邮件
    for (const admin of admins || []) {
      if (admin.email) {
        // 插入通知
        await supabase.from('notifications').insert({
          user_id: admin.user_id,
          type: 'daily_summary',
          title: `📊 每日摘要 — ${today}`,
          message: `超期${(overdue || []).length}个，今日到期${(todayDue || []).length}个，昨日完成${(yesterdayDone || []).length}个`,
          status: 'unread',
        });
      }

      // 微信推送
      if (admin.wechat_push_key) {
        const { sendWechatPush } = await import('@/lib/utils/wechat-push');
        await sendWechatPush(admin.wechat_push_key, `📊 每日摘要 ${today}`, summaryText).catch(() => {});
      }
    }

    // 发邮件摘要
    try {
      const { sendEmailNotification } = await import('@/lib/utils/notifications');
      const adminEmails = (admins || []).map(a => a.email).filter(Boolean);
      if (adminEmails.length > 0) {
        await sendEmailNotification(adminEmails, `[节拍器] 每日摘要 ${today}`, `
          <h2>📊 每日工作摘要</h2>
          <pre style="font-family:sans-serif;line-height:1.8">${summaryText.replace(/\*\*/g, '').replace(/\n/g, '<br>')}</pre>
        `);
      }
    } catch {}

    return NextResponse.json({ success: true, summary: summaryText });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}

export async function GET(req: Request) { return POST(req); }
