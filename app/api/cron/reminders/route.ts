import { checkAndSendReminders, checkDeliveryDeadlines } from '@/app/actions/notifications';
import { insertNotifications } from '@/lib/utils/notifications';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  // Verify cron secret if needed
  const authHeader = request.headers.get('authorization');
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 2026-08-11:这条每15分钟、承载升级链/督办日报/PO+生产提醒/财务重试的最关键 cron 此前完全游离于
  // R1-B 健康监控外(不写 automation_runs、不在 watchdog),静默挂了无人知(正是要根治的失败形态)。
  // 整体包进 runAutomationJob:写台账 + watchdog 可检测静默/zero-output;每步独立 try,一步失败不拖垮后续。
  const { runAutomationJob } = await import('@/lib/automation/run-job');
  const job = await runAutomationJob('reminders', { trigger: 'cron', notify: true }, async (svc) => {
    const steps: Array<{ step: string; ok: boolean; error?: string; critical?: boolean }> = [];
    const runStep = async <T,>(name: string, fn: () => Promise<T>, critical = false): Promise<T | 0> => {
      try { const v = await fn(); steps.push({ step: name, ok: true }); return v; }
      catch (e: any) { console.error(`[reminders] ${name} error:`, e?.message); steps.push({ step: name, ok: false, error: (e?.message || '').slice(0, 120), critical }); return 0; }
    };

    // 备忘提醒已随个人备忘功能一同下线(2026-08-01)
    const reminderResult = await runStep('reminders', () => checkAndSendReminders());
    const deliveryResult = await runStep('delivery_alerts', () => checkDeliveryDeadlines());
    const escalated = await runStep('unassigned_merchandiser', () => checkUnassignedMerchandiser(svc));           // 跟单未指定 24h 升级
    const supervisorAlerts = await runStep('admin_assistant_overdue', () => notifyAdminAssistantOverdue(svc));    // 督办日报
    const autoEscalated = await runStep('escalation_chain', () => runEscalationChain(svc));                       // 逾期 1/2/3/5 天分级上报
    const poReminders = await runStep('po_reminders', () => checkPoReminders(svc));                               // 采购提醒节点
    const prodIssueReminders = await runStep('production_issues', () => checkProductionIssueReminders(svc));      // 生产问题提醒
    const mattersMaterialized = await runStep('procurement_matters', async () => {                               // 采购风险中心物化
      const { materializeProcurementMatters } = await import('@/lib/services/procurement-matters.service');
      const r = await materializeProcurementMatters(svc as any, { mode: 'execute' });
      return (r as any)?.count ?? 'ok';
    });

    // 财务外发发件箱重试(审计 A3):退避重发失败的 sync*ToFinance,超上限置 dead → 企微告警(非 silent)
    const financeOutbox = await runStep('finance_outbox', async () => {
      const { processFinanceOutbox } = await import('@/lib/integration/finance-sync');
      const r = await processFinanceOutbox();
      if (r && typeof r === 'object' && (r.dead || 0) > 0) {
        try {
          const { sendWecomWebhook } = await import('@/lib/utils/wechat-push');
          await sendWecomWebhook('⛔ 财务外发同步失败(转 dead)',
            `有 ${r.dead} 条推送重试耗尽转 dead——订单/采购/收货等对财务的同步永久失败。请到 integration_outbox 查 status='dead' 人工重发或核查。`);
        } catch (e: any) { console.error('[reminders] finance dead 告警发送失败:', e?.message); }
      }
      return r;
    });

    // 配置盲区探针:env 缺失时 sync*ToFinance 静默 return{success:true}——既不发也不入 outbox。显性告警。
    if (!process.env.FINANCE_SYSTEM_URL || !process.env.INTEGRATION_API_KEY) {
      steps.push({ step: 'finance_config', ok: false, error: 'FINANCE_SYSTEM_URL/INTEGRATION_API_KEY 缺失', critical: true });
      try {
        const { sendWecomWebhook } = await import('@/lib/utils/wechat-push');
        await sendWecomWebhook('⚠️ 财务同步未配置',
          '缺 FINANCE_SYSTEM_URL / INTEGRATION_API_KEY → 所有对财务系统的推送被静默跳过,财务收不到任何订单/采购/收货数据。请检查节拍器生产环境变量。');
      } catch (e: any) { console.error('[reminders] 财务配置缺失告警发送失败:', e?.message); }
    }

    const notif = [supervisorAlerts, autoEscalated, poReminders, prodIssueReminders, escalated]
      .reduce((a: number, x) => a + (typeof x === 'number' ? x : 0), 0);
    return {
      eligible: steps.length,
      processed: steps.filter((s) => s.ok).length,
      failedItems: steps.filter((s) => !s.ok).length,
      notificationsCreated: notif,
      steps,
      metadata: { reminderResult, deliveryResult, escalated, supervisorAlerts, autoEscalated, poReminders, prodIssueReminders, mattersMaterialized, financeOutbox },
    };
  });

  return NextResponse.json({
    success: job.status !== 'failed',
    run_id: job.runId, health: job.health, status: job.status,
    ...(job.outcome.metadata || {}),
  }, { status: job.status === 'failed' ? 500 : 200 });
}

/**
 * 采购单自定义提醒节点:到点(remind_at ≤ 今天)的 pending 节点 → 通知
 * 采购(创建者)+ 该单每个订单的业务执行(owner_user_id)/创建者 + 跟单(milestone owner_role=merchandiser)。
 * 通知后置 status='notified'(只提醒一次,符合"自定义节点+日期"语义;需再提醒则改期,updatePoReminder 会重置回 pending)。
 * 表未建时静默返回 0,不炸整条 cron。
 */
async function checkPoReminders(supabase: any): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const { data: due, error } = await supabase
    .from('po_reminders')
    .select('id, purchase_order_id, label, note, remind_at, created_by')
    .eq('status', 'pending')
    .lte('remind_at', today);
  if (error) { if (!/does not exist/i.test(error.message)) console.error('[po_reminders] query:', error.message); return 0; }
  if (!due || due.length === 0) return 0;

  const poIds = [...new Set(due.map((r: any) => r.purchase_order_id))];
  const { data: pos } = await supabase.from('purchase_orders').select('id, po_no, order_ids').in('id', poIds);
  const poMap = new Map((pos || []).map((p: any) => [p.id, p]));
  const allOrderIds = [...new Set((pos || []).flatMap((p: any) => p.order_ids || []))];

  const orderMap = new Map<string, any>();
  const merchByOrder = new Map<string, string>();
  if (allOrderIds.length > 0) {
    const { data: orders } = await supabase.from('orders')
      .select('id, order_no, customer_name, owner_user_id, created_by').in('id', allOrderIds);
    for (const o of (orders || [])) orderMap.set(o.id, o);
    const { data: mRows } = await supabase.from('milestones')
      .select('order_id, owner_user_id, owner_role').in('order_id', allOrderIds).eq('owner_role', 'merchandiser');
    for (const m of (mRows || [])) if (m.owner_user_id) merchByOrder.set(m.order_id, m.owner_user_id);
  }

  const notifs: any[] = [];
  const markIds: string[] = [];
  let fired = 0;
  for (const r of due) {
    const po: any = poMap.get(r.purchase_order_id);
    markIds.push(r.id);   // PO 消失也标记,避免每 15 分钟反复扫
    if (!po) continue;
    const oids: string[] = po.order_ids || [];
    const mk = (uid: string, oid: string | null, o: any) => ({
      user_id: uid, type: 'po_reminder',
      title: `⏰ 采购提醒:${po.po_no || ''} — ${r.label}`,
      message: `采购单 ${po.po_no || po.id}${o ? `（订单 ${o.order_no || oid}${o.customer_name ? ` · ${o.customer_name}` : ''}）` : ''}追踪节点「${r.label}」到期(${r.remind_at})${r.note ? `;备注:${r.note}` : ''}。`,
      related_order_id: oid, status: 'unread', email_sent: false,
    });
    if (oids.length === 0) {
      if (r.created_by) notifs.push(mk(r.created_by, null, null));
    } else {
      for (const oid of oids) {
        const o = orderMap.get(oid);
        const set = new Set<string>([r.created_by, o?.owner_user_id, o?.created_by, merchByOrder.get(oid)].filter(Boolean) as string[]);
        for (const uid of set) notifs.push(mk(uid, oid, o));
      }
    }
    fired++;
  }
  if (notifs.length > 0) {
    const insR = await insertNotifications(notifs);
    if (!insR.ok) { console.error('[po_reminders] notify insert:', insR.error); return 0; }  // 未标记 → 下轮重试
  }
  if (markIds.length > 0) {
    await supabase.from('po_reminders').update({ status: 'notified', notified_at: new Date().toISOString() }).in('id', markIds);
  }
  return fired;
}

/**
 * 生产问题定时提醒(2026-07-22 生产今日工作台第3步):到提醒点仍未解决的 production_issues
 * → 通知 assigned_to(站内 + 企微)。防重:last_reminded_at >= remind_at 跳过。
 * 表未建(migration 未跑)时静默跳过,不报错。
 */
async function checkProductionIssueReminders(supabase: any): Promise<number> {
  const nowIso = new Date().toISOString();
  const { data: issues, error } = await supabase
    .from('production_issues')
    .select('id, order_id, title, severity, assigned_to, remind_at, last_reminded_at')
    .eq('status', 'open')
    .not('remind_at', 'is', null)
    .lte('remind_at', nowIso);
  if (error) { if (!/does not exist/i.test(error.message)) console.error('[prod_issue_remind] query:', error.message); return 0; }
  const due = (issues || []).filter((r: any) => !r.last_reminded_at || new Date(r.last_reminded_at) < new Date(r.remind_at));
  if (due.length === 0) return 0;

  const orderIds = [...new Set(due.map((r: any) => r.order_id))];
  const { data: orders } = await supabase.from('orders').select('id, order_no, internal_order_no, customer_name').in('id', orderIds);
  const orderMap = new Map<string, any>((orders || []).map((o: any) => [o.id, o]));

  const notifs: any[] = [];
  const recipients = new Set<string>();
  const markIds: string[] = [];
  for (const r of due) {
    markIds.push(r.id);           // 标记后即使无负责人也不反复扫
    if (!r.assigned_to) continue;
    const o: any = orderMap.get(r.order_id);
    const label = o?.internal_order_no || o?.order_no || r.order_id;
    notifs.push({
      user_id: r.assigned_to, type: 'production_issue_reminder',
      title: `⏰ 生产问题待跟进:${r.title}`,
      message: `订单 ${label}${o?.customer_name ? ` · ${o.customer_name}` : ''} 的生产问题「${r.title}」到提醒时间,确认是否已落地/关闭。`,
      related_order_id: r.order_id, status: 'unread', email_sent: false,
    });
    recipients.add(r.assigned_to);
  }
  if (notifs.length > 0) {
    const insR = await insertNotifications(notifs);
    if (!insR.ok) { console.error('[prod_issue_remind] notify insert:', insR.error); return 0; }  // 未标记 → 下轮重试
  }
  if (markIds.length > 0) {
    await supabase.from('production_issues').update({ last_reminded_at: nowIso }).in('id', markIds);
  }
  if (recipients.size > 0) {
    try {
      const { pushToUsers } = await import('@/lib/utils/wechat-push');
      await pushToUsers(supabase, Array.from(recipients), '⏰ 生产问题待跟进', '你负责的生产问题到提醒时间了,请到生产中心确认是否已落地。').catch(() => {});
    } catch (e: any) { console.error('[prod_issue_remind] push:', e?.message); }
  }
  return due.length;
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
    // 2026-05-18 修复：原逻辑「找任何一个 merch 节点 owner_user_id IS NULL」过敏，
    // 因为 30 节点订单常有下游节点尚未到时间还未认领，会误报「无跟单」。
    // 正确判断：只要存在至少一个已分配的 merchandiser 节点 → 主跟单已识别，跳过升级。
    const { data: assignedMerch } = await supabase
      .from('milestones')
      .select('id')
      .eq('order_id', order.id)
      .eq('owner_role', 'merchandiser')
      .not('owner_user_id', 'is', null)
      .limit(1);

    if (assignedMerch && assignedMerch.length > 0) continue; // 至少一个 merch 已分配 → 主跟单已定，跳过

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

    // 给每个人发通知(统一入口 service-role,防 RLS 静默拒收)
    await insertNotifications(recipients.map((userId: string) => ({
      user_id: userId,
      type: 'merchandiser_escalation',
      title: `🚨 ${order.order_no} 超过 24h 仍未指定跟单！`,
      message:
        `客户 ${order.customer_name || '?'} · ${order.quantity || '?'} 件\n` +
        `创建于 ${new Date(order.created_at).toLocaleString('zh-CN')}\n` +
        `请立即在订单详情页指定跟单人员，避免延误。`,
      related_order_id: order.id,
      status: 'unread',
    })));

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
  const { data: overdueRaw } = await supabase
    .from('milestones')
    .select('id, name, step_key, due_at, owner_role, owner_user_id, orders!inner(order_no, customer_name, owner_user_id, created_by, special_tags, notes)')
    .in('status', ['in_progress', '进行中'])
    .lt('due_at', todayStr)
    .order('due_at', { ascending: true })
    .limit(50);

  // 即将逾期：未完成 + due_at 在未来 3 天内
  const { data: soonOverdueRaw } = await supabase
    .from('milestones')
    .select('id, name, step_key, due_at, owner_role, owner_user_id, orders!inner(order_no, customer_name, owner_user_id, created_by, special_tags, notes)')
    .in('status', ['in_progress', '进行中', 'pending', '未开始'])
    .gte('due_at', todayStr)
    .lte('due_at', threeDaysLater)
    .order('due_at', { ascending: true })
    .limit(30);

  // 「待客户指令出运」豁免(2026-08-06):客户暂停的单,逾期是暂停的表象不是延误,
  // 不进督办日报、不催责任人 —— 否则 1022945/1022946 这类单每天被点名"业务逾期"。
  // 跟进提醒走订单列表的 holdStale 黄灯(超14天未更新),不在这里刷屏。
  const { isCustomerShipHoldFromOrder: isHold } = await import('@/lib/domain/customerShipHold');
  // 业务执行固定节点归一化到订单业务负责人(2026-07-28 审计 P1-3):督办日报显示的责任人与看板一致
  const { effectiveMilestoneOwner: normOwner } = await import('@/lib/domain/milestone-owner');
  const overdue = ((overdueRaw || []) as any[]).filter((m) => !m.orders || !isHold(m.orders)).map((m) => m.orders ? normOwner(m, m.orders) : m);
  const soonOverdue = ((soonOverdueRaw || []) as any[]).filter((m) => !m.orders || !isHold(m.orders)).map((m) => m.orders ? normOwner(m, m.orders) : m);

  const overdueList = (overdue || []) as any[];
  const soonList = (soonOverdue || []) as any[];

  // ── 出厂日已过·待核实(2026-08-10 CEO:「这个内容要给行政督办,让他们每天自己去找人解决」)──
  // CEO 驾驶舱里「出厂日已过 N 张」是订单级僵尸单,节点级日报(上面)漏掉它们
  //(那些单没人 in_progress)。用僵尸单分诊把它们分成两类,每天推给督办:
  //   suspected_shipped → 疑似货已出没维护 → 督办去核实实际情况,再一键收尾
  //   stalled           → 真晚了还在推     → 督办催责任人
  const zombie: Array<{ orderNo: string; orderId: string; customer: string; days: number; verdict: string }> = [];
  try {
    const { triageStaleOrder } = await import('@/lib/services/stale-order-triage');
    const { data: activeOrders } = await supabase
      .from('orders')
      .select('id, order_no, internal_order_no, customer_name, factory_date, etd, incoterm, lifecycle_status, order_purpose, special_tags, notes')
      .not('lifecycle_status', 'in', '("completed","已完成","cancelled","已取消","archived","已归档")');
    const todayYmd = now.toISOString().slice(0, 10);
    const candidates = ((activeOrders || []) as any[]).filter((o) => {
      if ((o.order_purpose || 'production') === 'sample') return false;
      if (isHold(o)) return false;   // 客户暂停出运:与节点日报同口径豁免
      const keyDate = o.incoterm === 'DDP' ? o.etd : (o.factory_date || o.etd);
      return keyDate && String(keyDate).slice(0, 10) < todayYmd;
    });
    if (candidates.length > 0) {
      const zids = candidates.map((o) => o.id);
      const msByOrder = new Map<string, any[]>();
      for (let i = 0; i < zids.length; i += 200) {
        const { data: zms } = await supabase
          .from('milestones').select('order_id, status, due_at, actual_at').in('order_id', zids.slice(i, i + 200));
        for (const m of (zms || []) as any[]) msByOrder.set(m.order_id, [...(msByOrder.get(m.order_id) || []), m]);
      }
      const nowMs = now.getTime();
      for (const o of candidates) {
        const ms = msByOrder.get(o.id) || [];
        const overdueCount = ms.filter((m: any) => !['done', '已完成', 'completed'].includes(String(m.status || '').toLowerCase()) && m.due_at && new Date(m.due_at).getTime() < nowMs).length;
        const keyDate = o.incoterm === 'DDP' ? o.etd : (o.factory_date || o.etd);
        const tri = triageStaleOrder({ factoryDate: keyDate ? String(keyDate).slice(0, 10) : null, actualAts: ms.map((m: any) => m.actual_at), overdueCount, now: nowMs });
        if (tri.verdict === 'suspected_shipped' || tri.verdict === 'stalled') {
          zombie.push({ orderNo: o.internal_order_no || o.order_no || String(o.id).slice(0, 8), orderId: o.id, customer: o.customer_name || '', days: tri.pastFactoryDays ?? 0, verdict: tri.verdict });
        }
      }
      zombie.sort((a, b) => b.days - a.days);
    }
  } catch (e: any) { console.error('[督办日报] 僵尸单分诊失败(不阻断):', e?.message); }

  if (overdueList.length === 0 && soonList.length === 0 && zombie.length === 0) return 0;

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
    lines.push('');
  }

  // 出厂日已过·待督办核实/催办(CEO 2026-08-10:每天让督办去找人解决)
  const suspected = zombie.filter((z) => z.verdict === 'suspected_shipped');
  const stalled = zombie.filter((z) => z.verdict === 'stalled');
  if (suspected.length > 0) {
    lines.push(`🚢 出厂日已过·疑似已出货待核实（${suspected.length} 单）—— 请逐一联系责任人核实实际进度,已出货的一键收尾`);
    for (const z of suspected.slice(0, 20)) lines.push(`  • ${z.orderNo} · ${z.customer}（出厂已过 ${z.days} 天）`);
    if (suspected.length > 20) lines.push(`  ...还有 ${suspected.length - 20} 单`);
    lines.push('');
  }
  if (stalled.length > 0) {
    lines.push(`🔴 出厂日已过·真延误还在推（${stalled.length} 单）—— 请催责任人加速`);
    for (const z of stalled.slice(0, 20)) lines.push(`  • ${z.orderNo} · ${z.customer}（出厂已过 ${z.days} 天）`);
    if (stalled.length > 20) lines.push(`  ...还有 ${stalled.length - 20} 单`);
    lines.push('');
  }

  lines.push('请督促相关人员尽快推进。');

  const msg = lines.join('\n');
  const title = `📊 督办日报 — ${overdueList.length} 项逾期 / ${soonList.length} 即将到期${zombie.length > 0 ? ` / ${zombie.length} 单出厂已过待核办` : ''}`;

  // 发给每个 admin_assistant(统一入口 service-role)
  await insertNotifications(assistants.map((userId: string) => ({
    user_id: userId,
    type: 'supervisor_daily_overdue',
    title,
    message: msg.slice(0, 1500),
    status: 'unread',
  })));

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

  // 查所有逾期的 in_progress 节点 —— 此前 .limit(100) 取最老 100 条,逾期>100 时较新逾期永远拿不到
  // L1–L5 升级(旧逾期饿死新逾期,2026-08-11 审计)。改分页拉全量(升级有 dedup,重扫已升级的很便宜;
  // fetchAllPages 自带 HARD_MAX 保护,失真会显性报错而非静默截断)。
  const { fetchAllPages } = await import('@/lib/db/truth-query');
  const { rows: overdueRawEsc, error: escErr } = await fetchAllPages((from, to) => supabase
    .from('milestones')
    .select('id, name, step_key, due_at, owner_user_id, owner_role, order_id, orders!inner(order_no, customer_name, created_by, owner_user_id, special_tags, notes)')
    .in('status', ['in_progress', '进行中'])
    .lt('due_at', now.toISOString())
    .order('due_at', { ascending: true })
    .range(from, to));
  if (escErr) console.error('[escalation] 逾期节点分页拉取异常:', escErr);

  // 「待客户指令出运」豁免(2026-08-06,与督办日报同口径):客户暂停不进升级链
  const { isCustomerShipHoldFromOrder: isHoldEsc } = await import('@/lib/domain/customerShipHold');
  // 业务执行固定节点归一化(2026-07-28 审计 P1-3):升级链催办要 @ 到订单业务负责人,不是原始(可能空/生产)owner
  const { effectiveMilestoneOwner: normEscOwner } = await import('@/lib/domain/milestone-owner');
  const overdue = ((overdueRawEsc || []) as any[]).filter((m) => !m.orders || !isHoldEsc(m.orders)).map((m) => {
    const n: any = m.orders ? normEscOwner(m, m.orders) : m;
    // 无人认领兜底(存量 400 空 owner 节点=催办盲区)→ 催到订单负责人/建单人
    if (!n.owner_user_id) n.owner_user_id = m.orders?.owner_user_id || m.orders?.created_by || null;
    return n;
  });

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

    // 给每个人发通知（用 dedupKey 作为 type 防重复；统一入口 service-role）
    await insertNotifications((recipients as string[]).map((uid) => ({
      user_id: uid,
      type: dedupKey,
      title,
      message,
      related_order_id: m.order_id,
      related_milestone_id: m.id,
      status: 'unread',
    })));

    // 微信推送
    try {
      const { pushToUsers } = await import('@/lib/utils/wechat-push');
      await pushToUsers(supabase, Array.from(recipients), title, message).catch(() => {});
    } catch {}

    escalatedCount++;
  }

  return escalatedCount;
}
