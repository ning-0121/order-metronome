/**
 * 每日个人待办推送 — 北京时间 08:00
 *
 * CEO 痛点：员工收到 50 条通知但不知道今天该做什么。
 * 解决：每天早上给每个人推 1 条消息，只列 Top 3 最紧急的任务。
 *
 * 推送内容：
 *   ☀ 早上好，[名字]！今天你有 3 件事要做：
 *   🔴 QM-xxx 财务审核（逾期 2 天）→ [直达链接]
 *   🟡 QM-yyy 采购下单（明天截止）→ [直达链接]
 *   ⚪ QM-zzz 中查验货（还剩 3 天）→ [直达链接]
 *
 * 通道：站内通知 + 微信推送
 */

import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export const maxDuration = 60;

export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ error: 'Missing config' }, { status: 500 });

  const supabase = createClient(url, key);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://order.qimoactivewear.com';
  const now = new Date();
  const todayStr = now.toISOString();
  let totalPushed = 0;

  try {
    // 获取所有活跃用户（有角色的）
    const { data: profiles } = await supabase
      .from('profiles')
      .select('user_id, name, email, role, roles');

    for (const profile of (profiles || []) as any[]) {
      const roles: string[] = Array.isArray(profile.roles) && profile.roles.length > 0
        ? profile.roles : [profile.role].filter(Boolean);
      if (roles.length === 0) continue;
      if (roles.includes('admin') && roles.length === 1) continue; // 纯 admin 不推（CEO 看全局报告）

      const userName = profile.name || profile.email?.split('@')[0] || '同事';

      // 查这个人负责的未完成节点（按紧急度排序）
      const { data: myMilestones } = await supabase
        .from('milestones')
        .select('id, name, step_key, due_at, status, order_id, orders!inner(order_no, customer_name)')
        .eq('owner_user_id', profile.user_id)
        .in('status', ['in_progress', '进行中'])
        .not('due_at', 'is', null)
        .order('due_at', { ascending: true })
        .limit(10);

      if (!myMilestones || myMilestones.length === 0) continue;

      // 分类：逾期 / 今天到期 / 即将到期（3天内）/ 其他
      const tasks: Array<{
        emoji: string;
        order_no: string;
        customer: string;
        name: string;
        urgency: string;
        order_id: string;
        priority: number;
      }> = [];

      for (const m of myMilestones as any[]) {
        const dueDate = new Date(m.due_at);
        const diffDays = Math.ceil((dueDate.getTime() - now.getTime()) / 86400000);

        let emoji: string;
        let urgency: string;
        let priority: number;

        if (diffDays < 0) {
          emoji = '🔴';
          urgency = `逾期 ${Math.abs(diffDays)} 天`;
          priority = 100 + Math.abs(diffDays); // 逾期越久越靠前
        } else if (diffDays === 0) {
          emoji = '🟠';
          urgency = '今天截止';
          priority = 50;
        } else if (diffDays <= 3) {
          emoji = '🟡';
          urgency = `还剩 ${diffDays} 天`;
          priority = 30 - diffDays;
        } else {
          emoji = '⚪';
          urgency = `还剩 ${diffDays} 天`;
          priority = 0;
        }

        tasks.push({
          emoji,
          order_no: m.orders?.order_no || '?',
          customer: m.orders?.customer_name || '',
          name: m.name,
          urgency,
          order_id: m.order_id,
          priority,
        });
      }

      // 按优先级排序，取 Top 3
      tasks.sort((a, b) => b.priority - a.priority);
      const top3 = tasks.slice(0, 3);

      if (top3.length === 0) continue;

      // 组织消息
      const overdueCount = tasks.filter(t => t.priority >= 100).length;
      const todayCount = tasks.filter(t => t.priority >= 50 && t.priority < 100).length;

      const greeting = now.getHours() < 12 ? '☀ 早上好' : '👋 下午好';
      const headerLine = overdueCount > 0
        ? `${greeting}，${userName}！你有 ${overdueCount} 项逾期需要立即处理：`
        : todayCount > 0
        ? `${greeting}，${userName}！今天有 ${todayCount} 项到期：`
        : `${greeting}，${userName}！接下来 3 天你需要关注：`;

      const taskLines = top3.map(t =>
        `${t.emoji} ${t.order_no}（${t.customer}）· ${t.name}（${t.urgency}）`
      ).join('\n');

      const linkLines = top3.map(t =>
        `→ ${appUrl}/orders/${t.order_id}?tab=progress`
      ).join('\n');

      const fullMessage = `${headerLine}\n\n${taskLines}\n\n${linkLines}`;

      const title = overdueCount > 0
        ? `🔴 ${userName}，${overdueCount} 项逾期待处理`
        : `📋 ${userName}，今日待办 ${top3.length} 项`;

      // 写站内通知
      await supabase.from('notifications').insert({
        user_id: profile.user_id,
        type: 'daily_tasks',
        title,
        message: fullMessage.slice(0, 1500),
        status: 'unread',
      });

      // 微信推送
      try {
        const { pushToUsers } = await import('@/lib/utils/wechat-push');
        await pushToUsers(supabase, [profile.user_id], title, fullMessage).catch(() => {});
      } catch {}

      totalPushed++;
    }

    return NextResponse.json({ success: true, pushed: totalPushed });
  } catch (err: any) {
    console.error('[daily-tasks]', err?.message);
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}
