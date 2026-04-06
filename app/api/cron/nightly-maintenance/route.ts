/**
 * 每晚自动维护 — 22:00 北京时间运行
 *
 * 1. 健康检查：检测卡壳状态、孤立数据、异常状态
 * 2. 数据清理：过期建议、旧通知、卡死状态
 * 3. 自动修复：可安全自动修复的问题
 * 4. 生成健康报告：通知管理员
 */

import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export const maxDuration = 60;

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
    const report: string[] = [];
    let issuesFound = 0;
    let autoFixed = 0;

    report.push(`🔧 每晚维护报告 — ${new Date().toISOString().slice(0, 10)}`);
    report.push('');

    // ════ 1. 健康检查 ════
    report.push('【健康检查】');

    // 1a. 检测卡死的 executing 状态
    const { data: stuckExecuting } = await supabase
      .from('agent_actions')
      .select('id')
      .eq('status', 'executing')
      .lt('created_at', new Date(Date.now() - 10 * 60 * 1000).toISOString());
    if (stuckExecuting && stuckExecuting.length > 0) {
      report.push(`⚠ 发现 ${stuckExecuting.length} 个 Agent 动作卡在 executing 状态`);
      // 自动修复：回退到 pending
      await supabase.from('agent_actions')
        .update({ status: 'pending' })
        .eq('status', 'executing')
        .lt('created_at', new Date(Date.now() - 10 * 60 * 1000).toISOString());
      report.push(`  ✅ 已自动回退到 pending`);
      autoFixed++;
    } else {
      report.push('✅ Agent 动作状态正常');
    }

    // 1b. 检测未分配负责人的进行中节点
    const { data: unassigned } = await supabase
      .from('milestones')
      .select('id, name, owner_role, orders!inner(order_no)')
      .in('status', ['in_progress', '进行中'])
      .is('owner_user_id', null);
    if (unassigned && unassigned.length > 0) {
      report.push(`⚠ ${unassigned.length} 个进行中节点无负责人`);
      const roles = [...new Set(unassigned.map((m: any) => m.owner_role))];
      report.push(`  涉及角色：${roles.join('、')}`);
      // 自动修复：尝试分配（如果该角色只有1人）
      for (const role of roles) {
        const { data: candidates } = await supabase
          .from('profiles')
          .select('user_id')
          .or(`role.eq.${role},roles.cs.{${role}}`);
        if (candidates && candidates.length === 1) {
          const userId = candidates[0].user_id;
          const roleNodes = unassigned.filter((m: any) => m.owner_role === role);
          await supabase.from('milestones')
            .update({ owner_user_id: userId })
            .in('id', roleNodes.map((m: any) => m.id));
          report.push(`  ✅ ${role} 角色自动分配 ${roleNodes.length} 个节点`);
          autoFixed++;
        }
      }
      issuesFound++;
    } else {
      report.push('✅ 所有进行中节点都有负责人');
    }

    // 1c. 检测订单状态异常（所有节点完成但订单未标记完成）
    const { data: activeOrders } = await supabase
      .from('orders')
      .select('id, order_no')
      .in('lifecycle_status', ['执行中', 'running', 'active']);
    let staleOrders = 0;
    for (const order of activeOrders || []) {
      const { data: milestones } = await supabase
        .from('milestones')
        .select('status')
        .eq('order_id', order.id);
      if (milestones && milestones.length > 0) {
        const allDone = milestones.every((m: any) => m.status === 'done' || m.status === '已完成');
        if (allDone) {
          staleOrders++;
          report.push(`⚠ 订单 ${order.order_no} 所有节点已完成但状态仍为执行中`);
          // 自动修复：更新订单状态
          await supabase.from('orders')
            .update({ lifecycle_status: '已完成' })
            .eq('id', order.id);
          report.push(`  ✅ 已自动标记为已完成`);
          autoFixed++;
        }
      }
    }
    if (staleOrders === 0) report.push('✅ 订单状态与节点状态一致');

    // ════ 2. 数据清理 ════
    report.push('');
    report.push('【数据清理】');

    // 2a. 清理7天前的已执行/已忽略Agent建议
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const { count: oldActions } = await supabase
      .from('agent_actions')
      .delete()
      .in('status', ['executed', 'dismissed', 'expired'])
      .lt('created_at', sevenDaysAgo)
      .select('id', { count: 'exact', head: true });
    report.push(`🗑 清理旧Agent建议：${oldActions || 0} 条`);

    // 2b. 清理30天前的已读通知
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
    const { count: oldNotifs } = await supabase
      .from('notifications')
      .delete()
      .eq('status', 'read')
      .lt('created_at', thirtyDaysAgo)
      .select('id', { count: 'exact', head: true });
    report.push(`🗑 清理旧通知：${oldNotifs || 0} 条`);

    // 2c. 过期Agent建议标记
    const { count: expiredCount } = await supabase
      .from('agent_actions')
      .update({ status: 'expired' })
      .eq('status', 'pending')
      .lt('expires_at', new Date().toISOString())
      .select('id', { count: 'exact', head: true });
    report.push(`⏰ 过期建议标记：${expiredCount || 0} 条`);

    // ════ 3. 系统统计 ════
    report.push('');
    report.push('【系统统计】');

    const { count: totalOrders } = await supabase.from('orders').select('id', { count: 'exact', head: true });
    const { count: activeCount } = await supabase.from('orders').select('id', { count: 'exact', head: true }).in('lifecycle_status', ['执行中', 'running', 'active', '已生效']);
    const { count: overdueCount } = await supabase.from('milestones').select('id', { count: 'exact', head: true }).in('status', ['in_progress', '进行中']).lt('due_at', new Date().toISOString());
    const { count: agentTotal } = await supabase.from('agent_actions').select('id', { count: 'exact', head: true });

    report.push(`📦 总订单：${totalOrders || 0}，活跃：${activeCount || 0}`);
    report.push(`🔴 超期节点：${overdueCount || 0}`);
    report.push(`🤖 Agent 建议总计：${agentTotal || 0}`);

    // ════ 4. 汇总 ════
    report.push('');
    report.push(`════ 汇总 ════`);
    report.push(`问题发现：${issuesFound}`);
    report.push(`自动修复：${autoFixed}`);
    report.push(`状态：${issuesFound === 0 ? '✅ 系统健康' : '⚠ 有问题需关注'}`);

    const reportText = report.join('\n');

    // 通知管理员
    const { data: admins } = await supabase
      .from('profiles')
      .select('user_id, wechat_push_key')
      .or("role.eq.admin,roles.cs.{admin}");

    for (const admin of admins || []) {
      await supabase.from('notifications').insert({
        user_id: admin.user_id,
        type: 'nightly_maintenance',
        title: `🔧 每晚维护完成 — ${issuesFound === 0 ? '系统健康' : `${autoFixed}项自动修复`}`,
        message: reportText.slice(0, 500),
        status: 'unread',
      }).catch(() => {});

      // 微信推送
      if (admin.wechat_push_key) {
        const { sendWechatPush } = await import('@/lib/utils/wechat-push');
        await sendWechatPush(admin.wechat_push_key, '🔧 每晚维护报告', reportText).catch(() => {});
      }
    }

    return NextResponse.json({ success: true, report: reportText, issuesFound, autoFixed });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}

export async function GET(req: Request) { return POST(req); }
