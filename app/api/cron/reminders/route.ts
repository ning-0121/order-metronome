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
    let escalated = 0;
    // ── 行政督办：逾期/即将逾期通知 ──
    let supervisorAlerts = 0;
    // ── 自动升级链：逾期 1/2/3/5 天分级上报 ──
    let autoEscalated = 0;
    try {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (url && key) {
        const supabase = createClient(url, key);
        escalated = await checkUnassignedMerchandiser(supabase);
        supervisorAlerts = await notifyAdminAssistantOverdue(supabase);
        autoEscalated = await runEscalationChain(supabase);
      }
    } catch (e: any) {
      console.error('[reminders] extra checks error:', e?.message);
    }

    return NextResponse.json({
      success: true,
      reminders: reminderResult,
      delivery_alerts: deliveryResult,
      memo_reminders: memoReminderResult,
      merchandiser_escalated: escalated,
      supervisor_alerts: supervisorAlerts,
      auto_escalated: autoEscalated,
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

/**
 * 行政督办：每天汇总即将逾期 + 已逾期的节点，发给 admin_assistant
 *
 * 即将逾期 = 未完成 + due_at 在今天之后 3 天以内
 * 已逾期 = in_progress + due_at < 今天
 *
 * 每天只推一次汇总（用日期去重 type='supervisor_daily_overdue'）
 * 运行频率：每 15 分钟检查一次，但同一天只发一条
 */
async function notifyAdminAssistantOverdue(supabase: any): Promise<number> {
  // 找 admin_assistant 用户
  const { data: profiles } = await supabase
    .from('profiles')
    .select('user_id, roles, role');
  const assistants: string[] = [];
  for (const p of (profiles || []) as any[]) {
    const roles: string[] = Array.isArray(p.roles) && p.roles.length > 0 ? p.roles : [p.role].filter(Boolean);
    if (roles.includes('admin_assistant')) assistants.push(p.user_id);
  }
  if (assistants.length === 0) return 0;

  // 去重：今天是否已发过
  const today = new Date().toISOString().slice(0, 10);
  const { data: existingToday } = await supabase
    .from('notifications')
    .select('id')
    .eq('type', 'supervisor_daily_overdue')
    .gte('created_at', `${today}T00:00:00Z`)
    .in('user_id', assistants)
    .limit(1);
  if (existingToday && existingToday.length > 0) return 0; // 今天已发

  const now = new Date();
  const threeDaysLater = new Date(now.getTime() + 3 * 86400000).toISOString();
  const todayStr = now.toISOString();

  // 已逾期：in_progress + due_at < now
  const { data: overdue } = await supabase
    .from('milestones')
    .select('id, name, step_key, due_at, owner_role, owner_user_id, orders!inner(order_no, customer_name)')
    .in('status', ['in_progress', '进行中'])
    .lt('due_at', todayStr)
    .order('due_at', { ascending: true })
    .limit(50);

  // 即将逾期：未完成 + due_at 在未来 3 天内
  const { data: soonOverdue } = await supabase
    .from('milestones')
    .select('id, name, step_key, due_at, owner_role, owner_user_id, orders!inner(order_no, customer_name)')
    .in('status', ['in_progress', '进行中', 'pending', '未开始'])
    .gte('due_at', todayStr)
    .lte('due_at', threeDaysLater)
    .order('due_at', { ascending: true })
    .limit(30);

  const overdueList = (overdue || []) as any[];
  const soonList = (soonOverdue || []) as any[];
  if (overdueList.length === 0 && soonList.length === 0) return 0;

  // 拿负责人名字
  const allUserIds = [...new Set([...overdueList, ...soonList].map(m => m.owner_user_id).filter(Boolean))];
  const nameMap = new Map<string, string>();
  if (allUserIds.length > 0) {
    const { data: ownerProfiles } = await supabase
      .from('profiles')
      .select('user_id, name, email')
      .in('user_id', allUserIds);
    for (const p of (ownerProfiles || []) as any[]) {
      nameMap.set(p.user_id, p.name || p.email?.split('@')[0] || '?');
    }
  }

  // 组织消息
  const lines: string[] = [];
  lines.push(`📊 ${today} 督办日报\n`);

  if (overdueList.length > 0) {
    lines.push(`🔴 已逾期（${overdueList.length} 项）`);
    for (const m of overdueList.slice(0, 15)) {
      const days = Math.ceil((now.getTime() - new Date(m.due_at).getTime()) / 86400000);
      const owner = m.owner_user_id ? nameMap.get(m.owner_user_id) || '?' : '未分配';
      lines.push(`  • ${m.orders?.order_no} · ${m.name}（超 ${days} 天，${owner}）`);
    }
    if (overdueList.length > 15) lines.push(`  ...还有 ${overdueList.length - 15} 项`);
    lines.push('');
  }

  if (soonList.length > 0) {
    lines.push(`🟡 即将到期（${soonList.length} 项，3 天内）`);
    for (const m of soonList.slice(0, 10)) {
      const owner = m.owner_user_id ? nameMap.get(m.owner_user_id) || '?' : '未分配';
      lines.push(`  • ${m.orders?.order_no} · ${m.name}（截止 ${String(m.due_at).slice(0, 10)}，${owner}）`);
    }
    if (soonList.length > 10) lines.push(`  ...还有 ${soonList.length - 10} 项`);
  }

  lines.push('');
  lines.push('请督促相关人员尽快推进。');

  const msg = lines.join('\n');
  const title = `📊 督办日报 — ${overdueList.length} 项逾期 / ${soonList.length} 项即将到期`;

  // 发给每个 admin_assistant
  for (const userId of assistants) {
    await supabase.from('notifications').insert({
      user_id: userId,
      type: 'supervisor_daily_overdue',
      title,
      message: msg.slice(0, 1500),
      status: 'unread',
    });
  }

  // 微信推送
  try {
    const { pushToUsers } = await import('@/lib/utils/wechat-push');
    await pushToUsers(supabase, assistants, title, msg).catch(() => {});
  } catch {}

  return overdueList.length + soonList.length;
}

/**
 * 自动升级链 — 逾期节点分级上报
 *
 * Day +1: 催办责任人
 * Day +2: 上报主管（production_manager）+ 订单创建者
 * Day +3: 上报 CEO + 行政督办
 * Day +5: 严重阻塞，CEO 仪表盘置顶
 *
 * 去重：每个节点每个级别只触发一次（用 notification type 去重）
 */
async function runEscalationChain(supabase: any): Promise<number> {
  const { ESCALATION_CHAIN, getEscalationLevel, escalationDedupKey } = await import('@/lib/domain/escalation-chain');

  const now = new Date();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://order.qimoactivewear.com';

  // 查所有逾期的 in_progress 节点
  const { data: overdue } = await supabase
    .from('milestones')
    .select('id, name, step_key, due_at, owner_user_id, owner_role, order_id, orders!inner(order_no, customer_name, created_by)')
    .in('status', ['in_progress', '进行中'])
    .lt('due_at', now.toISOString())
    .order('due_at', { ascending: true })
    .limit(100);

  if (!overdue || overdue.length === 0) return 0;

  // 预加载所有角色用户
  const { data: allProfiles } = await supabase
    .from('profiles')
    .select('user_id, name, email, role, roles');
  const profilesByRole: Record<string, string[]> = {};
  for (const p of (allProfiles || []) as any[]) {
    const roles: string[] = Array.isArray(p.roles) && p.roles.length > 0 ? p.roles : [p.role].filter(Boolean);
    for (const r of roles) {
      if (!profilesByRole[r]) profilesByRole[r] = [];
      profilesByRole[r].push(p.user_id);
    }
  }
  const nameMap = new Map((allProfiles || []).map((p: any) => [p.user_id, p.name || p.email?.split('@')[0] || '?']));

  let escalatedCount = 0;

  for (const m of overdue as any[]) {
    const daysOverdue = Math.ceil((now.getTime() - new Date(m.due_at).getTime()) / 86400000);
    const level = getEscalationLevel(daysOverdue);
    if (!level) continue;

    // 去重：这个节点这个级别是否已通知过
    const dedupKey = escalationDedupKey(m.id, level.level);
    const { data: existing } = await supabase
      .from('notifications')
      .select('id')
      .eq('type', dedupKey)
      .limit(1);
    if (existing && existing.length > 0) continue;

    // 收集通知对象
    const recipients = new Set<string>();
    if (level.notifyOwner && m.owner_user_id) recipients.add(m.owner_user_id);
    if (level.notifyOrderCreator && m.orders?.created_by) recipients.add(m.orders.created_by);
    for (const role of level.notifyRoles) {
      for (const uid of (profilesByRole[role] || [])) recipients.add(uid);
    }
    if (recipients.size === 0) continue;

    const ownerName = m.owner_user_id ? nameMap.get(m.owner_user_id) || '?' : '未分配';
    const title = `${level.notificationPrefix} ${m.orders?.order_no} · ${m.name} 逾期 ${daysOverdue} 天`;
    const message = [
      `节点「${m.name}」已逾期 ${daysOverdue} 天`,
      `订单：${m.orders?.order_no}（${m.orders?.customer_name || '?'}）`,
      `负责人：${ownerName}`,
      `升级级别：L${level.level} — ${level.label}`,
      '',
      `→ ${appUrl}/orders/${m.order_id}?tab=progress`,
    ].join('\n');

    // 给每个人发通知（用 dedupKey 作为 type 防重复）
    for (const uid of recipients) {
      await supabase.from('notifications').insert({
        user_id: uid,
        type: dedupKey,
        title,
        message,
        related_order_id: m.order_id,
        related_milestone_id: m.id,
        status: 'unread',
      });
    }

    // 微信推送
    try {
      const { pushToUsers } = await import('@/lib/utils/wechat-push');
      await pushToUsers(supabase, Array.from(recipients), title, message).catch(() => {});
    } catch {}

    escalatedCount++;
  }

  return escalatedCount;
}
