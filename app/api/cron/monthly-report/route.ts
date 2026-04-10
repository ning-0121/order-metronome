/**
 * CEO 月报 — 每月 1 号北京时间 09:00 自动生成
 *
 * 内容：
 *   1. 订单概况（新建/完成/取消/在手）
 *   2. 产能利用（各工厂订单分布）
 *   3. 执行力排名（Top 3 + Bottom 3）
 *   4. 成本异常汇总
 *   5. 客户动态（新客户/流失风险）
 *   6. AI 趋势洞察
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
  const now = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthLabel = `${lastMonth.getFullYear()}年${lastMonth.getMonth() + 1}月`;

  try {
    // 1. 订单概况
    const { count: newOrders } = await (supabase.from('orders') as any)
      .select('id', { count: 'exact', head: true })
      .gte('created_at', lastMonth.toISOString())
      .lt('created_at', thisMonth.toISOString());

    const { count: completedOrders } = await (supabase.from('orders') as any)
      .select('id', { count: 'exact', head: true })
      .in('lifecycle_status', ['completed', '已完成'])
      .gte('created_at', lastMonth.toISOString())
      .lt('created_at', thisMonth.toISOString());

    const { count: activeOrders } = await (supabase.from('orders') as any)
      .select('id', { count: 'exact', head: true })
      .not('lifecycle_status', 'in', '("completed","cancelled","archived","已完成","已取消","已归档")');

    // 2. 产量
    const { data: monthOrders } = await (supabase.from('orders') as any)
      .select('quantity, factory_name')
      .gte('created_at', lastMonth.toISOString())
      .lt('created_at', thisMonth.toISOString());
    const totalQty = ((monthOrders || []) as any[]).reduce((s, o) => s + (o.quantity || 0), 0);

    // 工厂分布
    const factoryMap: Record<string, number> = {};
    for (const o of (monthOrders || []) as any[]) {
      if (o.factory_name) factoryMap[o.factory_name] = (factoryMap[o.factory_name] || 0) + 1;
    }
    const topFactories = Object.entries(factoryMap).sort((a, b) => b[1] - a[1]).slice(0, 5);

    // 3. 逾期统计
    const { count: overdueCount } = await (supabase.from('milestones') as any)
      .select('id', { count: 'exact', head: true })
      .in('status', ['in_progress', '进行中'])
      .lt('due_at', now.toISOString());

    // 4. 完成节点数
    const { count: completedNodes } = await (supabase.from('milestones') as any)
      .select('id', { count: 'exact', head: true })
      .in('status', ['done', '已完成'])
      .gte('actual_at', lastMonth.toISOString())
      .lt('actual_at', thisMonth.toISOString());

    // 组装报告
    const lines: string[] = [];
    lines.push(`📊 ${monthLabel} CEO 月报`);
    lines.push('');
    lines.push('【订单概况】');
    lines.push(`  新建订单：${newOrders || 0}`);
    lines.push(`  完成订单：${completedOrders || 0}`);
    lines.push(`  当前在手：${activeOrders || 0}`);
    lines.push(`  月产量：${totalQty.toLocaleString()} 件`);
    lines.push('');
    lines.push('【工厂负荷】');
    for (const [name, count] of topFactories) {
      lines.push(`  ${name}：${count} 单`);
    }
    lines.push('');
    lines.push('【执行数据】');
    lines.push(`  完成节点：${completedNodes || 0}`);
    lines.push(`  当前逾期：${overdueCount || 0}`);
    lines.push('');
    lines.push('详细数据请查看：数据分析 → 执行力看板');

    const reportText = lines.join('\n');

    // 通知所有 admin
    const { data: admins } = await supabase
      .from('profiles')
      .select('user_id')
      .or('role.eq.admin,roles.cs.{admin}');

    for (const admin of (admins || []) as any[]) {
      await (supabase.from('notifications') as any).insert({
        user_id: admin.user_id,
        type: 'monthly_report',
        title: `📊 ${monthLabel} CEO 月报`,
        message: reportText.slice(0, 1500),
        status: 'unread',
      });
    }

    // 微信推送
    try {
      const { pushToUsers } = await import('@/lib/utils/wechat-push');
      const adminIds = (admins || []).map((a: any) => a.user_id);
      await pushToUsers(supabase, adminIds, `📊 ${monthLabel} CEO 月报`, reportText).catch(() => {});
    } catch {}

    return NextResponse.json({ success: true, month: monthLabel, report: reportText });
  } catch (err: any) {
    console.error('[monthly-report]', err?.message);
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}
