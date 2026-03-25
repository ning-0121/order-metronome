import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { formatDate, isOverdue } from '@/lib/utils/date';
import { computeOrderStatus } from '@/lib/utils/order-status';
import Link from 'next/link';
import { TodayMustHandle } from '@/components/TodayMustHandle';
import { DelayRequestActions } from '@/components/DelayRequestActions';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import { getRoleLabel } from '@/lib/utils/i18n';
import { CeoAssistantActionPanel } from '@/components/CeoAssistantActionPanel';
import { inferRolesFromCategoryAndRequirement } from '@/lib/domain/requirements';

export default async function CEODashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) {
    redirect('/dashboard');
  }

  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const twoDaysLater = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // All orders with milestones (for risk orders)
  const { data: orders } = await supabase.from('orders').select('*').order('created_at', { ascending: false });
  const ordersWithMilestones: any[] = [];
  if (orders) {
    for (const o of orders as any[]) {
      const { data: milestones } = await supabase.from('milestones').select('*').eq('order_id', o.id);
      ordersWithMilestones.push({ ...o, milestones: milestones || [] });
    }
  }

  // Risk orders by color (RED / YELLOW / GREEN)
  const riskRed = ordersWithMilestones.filter((o: any) => computeOrderStatus(o.milestones || []).color === 'RED');
  const riskYellow = ordersWithMilestones.filter((o: any) => computeOrderStatus(o.milestones || []).color === 'YELLOW');
  const riskGreen = ordersWithMilestones.filter((o: any) => computeOrderStatus(o.milestones || []).color === 'GREEN');

  // Today Must Handle milestones
  const { data: allMilestonesWithOrders } = await (supabase.from('milestones') as any)
    .select(`
      id, order_id, name, owner_role, owner_user_id, due_at, status,
      orders!inner(id, order_no, customer_name)
    `)
    .order('due_at', { ascending: true });

  const todayMustHandleMilestones = (allMilestonesWithOrders || []).filter((m: any) => {
    if (m.status === '卡住') return true;
    if (m.status === '进行中' && m.due_at && new Date(m.due_at) <= tomorrow) return true;
    if (m.status !== '已完成' && m.due_at && new Date(m.due_at) < now) return true;
    return false;
  });

  const ownerUserIds = [...new Set((todayMustHandleMilestones || []).map((m: any) => m.owner_user_id).filter(Boolean))] as string[];
  let userMap: Record<string, any> = {};
  if (ownerUserIds.length > 0) {
    const { data: profiles } = await (supabase.from('profiles') as any)
      .select('user_id, email, name, role')
      .in('user_id', ownerUserIds);
    if (profiles) {
      userMap = (profiles as any[]).reduce((acc: Record<string, any>, p: any) => {
        acc[p.user_id] = p;
        return acc;
      }, {});
    }
  }

  const milestoneIds = (todayMustHandleMilestones || []).map((m: any) => m.id);
  let delayRequestMap: Record<string, boolean> = {};
  if (milestoneIds.length > 0) {
    const { data: dr } = await (supabase.from('delay_requests') as any)
      .select('milestone_id')
      .in('milestone_id', milestoneIds)
      .eq('status', 'pending');
    if (dr) delayRequestMap = (dr as any[]).reduce((acc, x) => ({ ...acc, [x.milestone_id]: true }), {});
  }

  const formattedTodayMilestones = (todayMustHandleMilestones || []).map((m: any) => ({
    id: m.id,
    order_id: m.order_id,
    name: m.name,
    owner_role: m.owner_role,
    owner_user_id: m.owner_user_id,
    owner_user: m.owner_user_id ? (userMap[m.owner_user_id] ? { user_id: m.owner_user_id, email: userMap[m.owner_user_id].email, full_name: userMap[m.owner_user_id].name || userMap[m.owner_user_id].email } : null) : null,
    due_at: m.due_at,
    status: m.status,
    order_no: m.orders?.order_no || '',
    customer_name: m.orders?.customer_name || '',
    has_pending_delay: !!delayRequestMap[m.id],
  }));

  // Pending delay requests
  const { data: pendingDelayRequests } = await (supabase.from('delay_requests') as any)
    .select(`
      *,
      milestones!inner(id, name, order_id, orders!inner(id, order_no, customer_name))
    `)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  // 今日里程碑日志（用于员工执行汇总）
  const { data: todayLogs } = await (supabase.from('milestone_logs') as any)
    .select(`
      id,
      created_at,
      milestone_id,
      order_id,
      actor_user_id,
      action,
      note,
      milestones!inner(id, name, owner_role),
      orders!inner(id, order_no, customer_name)
    `)
    .gte('created_at', startOfDay.toISOString())
    .lt('created_at', endOfDay.toISOString())
    .order('created_at', { ascending: true });

  // 今日风险通知（进入超期/阻塞）
  const { data: todayRiskNotifications } = await (supabase.from('notifications') as any)
    .select(`
      id,
      order_id,
      kind,
      sent_at,
      orders!inner(id, order_no, customer_name)
    `)
    .in('kind', ['overdue', 'blocked'])
    .gte('sent_at', startOfDay.toISOString())
    .lt('sent_at', endOfDay.toISOString());

  // 今日所有延期申请（用于重复问题分析）
  const { data: todayDelayRequestsAll } = await (supabase.from('delay_requests') as any)
    .select('id, order_id, reason_type, reason_detail, created_at')
    .gte('created_at', startOfDay.toISOString())
    .lt('created_at', endOfDay.toISOString());

  // 明日进入 24h 风险窗口的里程碑（due_at 在未来 24-48h 且未完成）
  const { data: tomorrowRiskMilestones } = await (supabase.from('milestones') as any)
    .select(`
      id,
      order_id,
      name,
      due_at,
      status,
      orders!inner(id, order_no, customer_name)
    `)
    .gte('due_at', tomorrow.toISOString())
    .lt('due_at', twoDaysLater.toISOString())
    .neq('status', 'done');

  // CEO 助手 · 今日行动建议数据
  interface CEOActionItem {
    id: string;
    kind: 'overdue' | 'blocked_24h' | 'pending_delay' | 'red_risk_soon';
    order_id: string;
    order_no: string;
    milestone_id: string;
    reason: string;
    suggestion: string;
  }

  const actionItems: CEOActionItem[] = [];
  let overdueCount = 0;
  let blockedOver24Count = 0;
  let redRiskSoonCount = 0;
  const pendingDelayCount = (pendingDelayRequests || []).length;

  // 1) Overdue milestones & blocked >24h, and orders entering red risk within 48h
  (ordersWithMilestones || []).forEach((o: any) => {
    const milestonesForOrder = (o.milestones || []) as any[];

    milestonesForOrder.forEach((m: any) => {
      const dueAt = m.due_at ? new Date(m.due_at) : null;

      // Overdue milestones (进行中且已超期)
      if (m.status === '进行中' && dueAt && isOverdue(m.due_at)) {
        overdueCount += 1;
        const daysOver = Math.max(
          1,
          Math.floor((now.getTime() - dueAt.getTime()) / (24 * 60 * 60 * 1000))
        );
        actionItems.push({
          id: `overdue-${m.id}`,
          kind: 'overdue',
          order_id: o.id,
          order_no: o.order_no,
          milestone_id: m.id,
          reason: `${m.name} 已超期${daysOver}天`,
          suggestion: '建议立即催办负责人，并确认新的完成时间或调整交期。',
        });
      }

      // Blocked milestones > 24h （如无 updated_at 列，则视为需要关注）
      if (m.status === '卡住') {
        const updatedAt = m.updated_at ? new Date(m.updated_at) : null;
        if (!updatedAt || updatedAt < oneDayAgo) {
          blockedOver24Count += 1;
          actionItems.push({
            id: `blocked-${m.id}`,
            kind: 'blocked_24h',
            order_id: o.id,
            order_no: o.order_no,
            milestone_id: m.id,
            reason: `${m.name} 已卡住超过24小时`,
            suggestion: '建议与负责人沟通解除阻塞，必要时调整资源或优先级。',
          });
        }
      }
    });

    // Orders entering red risk within 48h: 黄色风险 + 48 小时内有关键未完成节点
    const status = computeOrderStatus(milestonesForOrder || []);
    if (status.color === 'YELLOW') {
      const upcoming = (milestonesForOrder || [])
        .filter((m: any) => m.status !== '已完成' && m.due_at)
        .map((m: any) => ({ ...m, due: new Date(m.due_at) }))
        .filter((m: any) => m.due >= now && m.due <= twoDaysLater)
        .sort((a: any, b: any) => a.due.getTime() - b.due.getTime());

      if (upcoming.length > 0) {
        const first = upcoming[0];
        redRiskSoonCount += 1;
        actionItems.push({
          id: `redsoon-${o.id}`,
          kind: 'red_risk_soon',
          order_id: o.id,
          order_no: o.order_no,
          milestone_id: first.id,
          reason: `订单在未来48小时内有关键节点（${first.name}），当前为黄色风险。`,
          suggestion: '建议提前复盘时间线，并与客户/供应链沟通，防止订单滑入红色风险。',
        });
      }
    }
  });

  // 2) Pending delay approvals
  (pendingDelayRequests || []).forEach((request: any) => {
    const milestone = request.milestones;
    const order = milestone?.orders;
    if (!milestone || !order) return;

    const createdAt = request.created_at ? new Date(request.created_at) : null;
    const daysPending =
      createdAt != null
        ? Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / (24 * 60 * 60 * 1000)))
        : 0;

    actionItems.push({
      id: `delay-${request.id}`,
      kind: 'pending_delay',
      order_id: order.id,
      order_no: order.order_no,
      milestone_id: milestone.id,
      reason: `延期申请已等待审批${daysPending}天`,
      suggestion: '建议尽快审批延期，或要求团队补充客户确认证据。',
    });
  });

  let todaySummary = '';
  if (actionItems.length === 0) {
    todaySummary = '今日整体运行平稳，暂无需要你立即决策的事项。';
  } else {
    todaySummary = `今日共有 ${overdueCount} 个超期节点、${blockedOver24Count} 个阻塞超过24小时节点、${pendingDelayCount} 个延期申请待你审批、${redRiskSoonCount} 个订单在48小时内可能进入红色风险。建议你优先处理上方的行动建议。`;
  }

  // ===== 日度执行汇总：按人、按订单的 rule-based 统计 =====

  interface StaffExecutionSummary {
    user_id: string;
    name: string;
    role: string;
    completedCount: number;
    noteCount: number;
    blockedOrDelayedCount: number;
    orders: { order_id: string; order_no: string }[];
  }

  const actorIds = [
    ...new Set(((todayLogs || []) as any[]).map((l: any) => l.actor_user_id).filter(Boolean)),
  ] as string[];

  let actorProfileMap = new Map<string, any>();
  if (actorIds.length > 0) {
    const { data: actorProfiles } = await (supabase.from('profiles') as any)
      .select('user_id, email, name, role')
      .in('user_id', actorIds);
    actorProfileMap = new Map(
      ((actorProfiles || []) as any[]).map((p: any) => [p.user_id as string, p])
    );
  }

  const staffSummaryMap: Record<string, StaffExecutionSummary> = {};

  (todayLogs || []).forEach((log: any) => {
    const uid = log.actor_user_id as string | null;
    if (!uid) return;
    if (!staffSummaryMap[uid]) {
      const profile = actorProfileMap.get(uid);
      staffSummaryMap[uid] = {
        user_id: uid,
        name: profile?.name || profile?.email || '未命名',
        role: profile?.role || 'staff',
        completedCount: 0,
        noteCount: 0,
        blockedOrDelayedCount: 0,
        orders: [],
      };
    }
    const entry = staffSummaryMap[uid];
    const order = log.orders;
    if (order && !entry.orders.some((o) => o.order_id === order.id)) {
      entry.orders.push({ order_id: order.id, order_no: order.order_no });
    }

    switch (log.action as string) {
      case 'mark_done':
        entry.completedCount += 1;
        break;
      case 'execution_note':
        entry.noteCount += 1;
        break;
      case 'mark_blocked':
      case 'request_delay':
      case 'approve_delay':
      case 'reject_delay':
        entry.blockedOrDelayedCount += 1;
        break;
      default:
        break;
    }
  });

  const staffExecutionSummary = Object.values(staffSummaryMap).sort(
    (a, b) => b.completedCount - a.completedCount
  );

  // 执行概览（总里程碑数、新增卡住、延期相关动作数）
  const processedMilestoneCount = new Set(
    (todayLogs || []).map((l: any) => l.milestone_id as string)
  ).size;
  const newBlockedCount = (todayLogs || []).filter(
    (l: any) => l.action === 'mark_blocked'
  ).length;
  const delayEventCount = (todayLogs || []).filter((l: any) =>
    ['request_delay', 'approve_delay', 'reject_delay'].includes(l.action as string)
  ).length;

  // 今日新增风险订单（根据 notifications: overdue / blocked）
  const newRiskOrdersMap = new Map<string, any>();
  (todayRiskNotifications || []).forEach((n: any) => {
    const order = n.orders;
    if (!order) return;
    if (!newRiskOrdersMap.has(order.id)) {
      newRiskOrdersMap.set(order.id, {
        id: order.id,
        order_no: order.order_no,
        customer_name: order.customer_name,
        kinds: new Set<string>(),
      });
    }
    newRiskOrdersMap.get(order.id).kinds.add(n.kind);
  });
  const newRiskOrders = Array.from(newRiskOrdersMap.values());

  // 重复问题提示：包装相关延误
  const PACKAGING_KEYWORDS = [
    'packaging',
    '包装',
    'carton',
    '外箱',
    'hangtag',
    '吊牌',
    'barcode',
    '条码',
    'label',
    '标签',
    'polybag',
    '胶袋',
    'hanger',
    '衣架',
  ];

  function containsPackaging(text: string | null | undefined): boolean {
    if (!text) return false;
    const lower = text.toLowerCase();
    return PACKAGING_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
  }

  const packagingIssues = (todayDelayRequestsAll || []).filter((d: any) =>
    containsPackaging(d.reason_detail) || containsPackaging(d.reason_type)
  );

  const hasRepeatedPackagingIssue = packagingIssues.length >= 2;


  // All milestones for bottlenecks
  const { data: allMilestones } = await supabase.from('milestones').select('*');
  const bottlenecksByRole: Record<string, number> = {};
  const bottlenecksByUser: Record<string, { count: number; user_id: string; milestones: any[] }> = {};
  (allMilestones || []).forEach((m: any) => {
    if (m.status !== '卡住' && !(m.status === '进行中' && m.due_at && isOverdue(m.due_at))) return;
    const role = m.owner_role || 'unknown';
    bottlenecksByRole[role] = (bottlenecksByRole[role] || 0) + 1;
    const uid = m.owner_user_id || 'unassigned';
    if (!bottlenecksByUser[uid]) bottlenecksByUser[uid] = { count: 0, user_id: uid, milestones: [] };
    bottlenecksByUser[uid].count += 1;
    bottlenecksByUser[uid].milestones.push(m);
  });

  const userIds = Object.keys(bottlenecksByUser).filter((id) => id !== 'unassigned');
  const { data: userProfiles } = userIds.length > 0
    ? await (supabase.from('profiles') as any).select('user_id, email, name').in('user_id', userIds)
    : { data: [] };
  const userProfileMap = new Map(((userProfiles || []) as any[]).map((p: any) => [p.user_id, p]));

  // ===== 部门问题汇总（责任归属 V1）=====

  interface DepartmentIssueSummary {
    role: string;
    riskOrders: Set<string>;
    overdueMilestones: number;
    pendingChangeItems: number;
  }

  const deptSummary: Record<string, DepartmentIssueSummary> = {};

  function ensureDept(role: string): DepartmentIssueSummary {
    if (!deptSummary[role]) {
      deptSummary[role] = {
        role,
        riskOrders: new Set<string>(),
        overdueMilestones: 0,
        pendingChangeItems: 0,
      };
    }
    return deptSummary[role];
  }

  // 1) 风险订单：RED 风险订单按 owner_role 归属
  (riskRed || []).forEach((o: any) => {
    const milestonesForOrder = (ordersWithMilestones.find((x: any) => x.id === o.id)?.milestones ||
      []) as any[];
    const roles = new Set<string>();
    milestonesForOrder.forEach((m: any) => {
      if (m.owner_role) roles.add(m.owner_role);
    });
    roles.forEach((r) => ensureDept(r).riskOrders.add(o.id));
  });

  // 2) 超期里程碑：status!==已完成 且 isOverdue
  (allMilestones || []).forEach((m: any) => {
    if (!m.owner_role) return;
    if (m.status === '已完成') return;
    if (m.due_at && isOverdue(m.due_at)) {
      ensureDept(m.owner_role).overdueMilestones += 1;
    }
  });

  // 3) requirement_type 为 change/pending 的记忆项，按类别映射到部门
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const { data: requirementMemories } = await (supabase.from('customer_memory') as any)
    .select('order_id, category, source_type, content_json, created_at')
    .not('order_id', 'is', null)
    .gte('created_at', ninetyDaysAgo);

  (requirementMemories || []).forEach((m: any) => {
    const cj = m.content_json || {};
    const t = (cj.requirement_type || '') as string;
    if (t !== 'change' && t !== 'pending') return;
    const roles = inferRolesFromCategoryAndRequirement(m.category as string | null, m.source_type as string | null);
    roles.forEach((r) => ensureDept(r).pendingChangeItems++);
  });

  return (
    <div className="space-y-6 bg-white text-gray-900 min-h-screen p-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">CEO 看板</h1>
        <p className="text-gray-600 mt-2">今日概览、风险订单、延期审批与瓶颈排行</p>
      </div>

      <CeoAssistantActionPanel
        items={actionItems.slice(0, 10)}
        pendingDelayCount={pendingDelayCount}
        summaryText={todaySummary}
      />

      {/* 部门问题汇总 */}
      <div>
        <h2 className="text-2xl font-semibold mb-4 text-gray-900">部门问题汇总</h2>
        {Object.keys(deptSummary).length === 0 ? (
          <p className="text-gray-600 bg-gray-50 p-4 rounded">暂无部门问题数据。</p>
        ) : (
          <div className="rounded-lg border border-gray-200 bg-white p-6">
            <table className="w-full text-gray-900">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left py-2 font-semibold">部门</th>
                  <th className="text-left py-2 font-semibold">风险订单数</th>
                  <th className="text-left py-2 font-semibold">超期里程碑数</th>
                  <th className="text-left py-2 font-semibold">变更/待澄清需求项</th>
                </tr>
              </thead>
              <tbody>
                {Object.values(deptSummary)
                  .sort((a, b) => {
                    const aTotal =
                      a.riskOrders.size + a.overdueMilestones + a.pendingChangeItems;
                    const bTotal =
                      b.riskOrders.size + b.overdueMilestones + b.pendingChangeItems;
                    return bTotal - aTotal;
                  })
                  .map((d) => (
                    <tr key={d.role} className="border-b border-gray-100">
                      <td className="py-2 font-medium">{getRoleLabel(d.role)}</td>
                      <td className="py-2">{d.riskOrders.size}</td>
                      <td className="py-2">{d.overdueMilestones}</td>
                      <td className="py-2">{d.pendingChangeItems}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 今日执行汇总（可折叠） */}
      <details className="rounded-lg border border-gray-200 bg-white p-4" open>
        <summary className="cursor-pointer text-lg font-semibold text-gray-900 flex items-center justify-between">
          <span>今日执行汇总</span>
          <span className="text-xs text-gray-500">点击展开 / 收起</span>
        </summary>
        <div className="mt-4 space-y-4 text-gray-900">
          {/* a) 今日执行概览 */}
          <section>
            <h3 className="text-sm font-semibold text-gray-800 mb-2">今日执行概览</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
              <div className="rounded-md bg-gray-50 border border-gray-200 p-3">
                <div className="text-gray-600">处理里程碑数</div>
                <div className="mt-1 text-xl font-semibold text-gray-900">
                  {processedMilestoneCount}
                </div>
              </div>
              <div className="rounded-md bg-red-50 border border-red-100 p-3">
                <div className="text-gray-600">新增卡住节点</div>
                <div className="mt-1 text-xl font-semibold text-red-700">
                  {newBlockedCount}
                </div>
              </div>
              <div className="rounded-md bg-yellow-50 border border-yellow-100 p-3">
                <div className="text-gray-600">延期相关操作</div>
                <div className="mt-1 text-xl font-semibold text-yellow-700">
                  {delayEventCount}
                </div>
              </div>
            </div>
          </section>

          {/* b) 员工执行摘要（按人） */}
          <section>
            <h3 className="text-sm font-semibold text-gray-800 mb-2">
              员工执行摘要（按人）
            </h3>
            {staffExecutionSummary.length === 0 ? (
              <p className="text-sm text-gray-600">今日暂无需要记录的执行活动。</p>
            ) : (
              <div className="space-y-2 text-sm">
                {staffExecutionSummary.map((s) => (
                  <div
                    key={s.user_id}
                    className="rounded-md border border-gray-200 bg-gray-50 p-3 flex flex-col md:flex-row md:items-center md:justify-between gap-2"
                  >
                    <div>
                      <div className="font-semibold text-gray-900">
                        {s.name}{' '}
                        <span className="text-xs text-gray-500 align-middle">
                          ({getRoleLabel(s.role)})
                        </span>
                      </div>
                      {s.orders.length > 0 && (
                        <div className="text-xs text-gray-600 mt-1">
                          涉及订单：
                          {s.orders
                            .slice(0, 3)
                            .map((o) => o.order_no)
                            .join('、')}
                          {s.orders.length > 3 && ' 等'}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs md:text-sm">
                      <span className="px-2 py-0.5 rounded-full bg-green-50 text-green-700 border border-green-200">
                        完成 {s.completedCount}
                      </span>
                      <span className="px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
                        执行备注 {s.noteCount}
                      </span>
                      <span className="px-2 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200">
                        卡住/延期 {s.blockedOrDelayedCount}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* c) 今日新增风险 */}
          <section>
            <h3 className="text-sm font-semibold text-gray-800 mb-2">今日新增风险</h3>
            {newRiskOrders.length === 0 ? (
              <p className="text-sm text-gray-600">今日无新增进入超期或阻塞的订单。</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {newRiskOrders.slice(0, 10).map((o: any) => (
                  <li key={o.id}>
                    <Link
                      href={`/orders/${o.id}`}
                      className="text-blue-600 hover:text-blue-700"
                    >
                      {o.order_no}
                    </Link>{' '}
                    — {o.customer_name}{' '}
                    <span className="text-xs text-red-700">
                      ({Array.from(o.kinds).join(' / ')})
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* d) 重复问题提示 */}
          <section>
            <h3 className="text-sm font-semibold text-gray-800 mb-2">重复问题提示</h3>
            {!hasRepeatedPackagingIssue ? (
              <p className="text-sm text-gray-600">今日尚未发现明显重复问题。</p>
            ) : (
              <ul className="list-disc list-inside text-sm text-gray-700">
                <li>
                  包装相关延期/问题今日出现 {packagingIssues.length} 次，建议复盘包装确认流程（外箱规格、吊牌条码、贴标、包装物料到货与生产提前期）。
                </li>
              </ul>
            )}
          </section>

          {/* e) 明日提醒 */}
          <section>
            <h3 className="text-sm font-semibold text-gray-800 mb-2">明日提醒</h3>
            {!tomorrowRiskMilestones || tomorrowRiskMilestones.length === 0 ? (
              <p className="text-sm text-gray-600">未来 24–48 小时内暂无关键节点进入风险窗口。</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {(tomorrowRiskMilestones as any[]).slice(0, 10).map((m: any) => (
                  <li key={m.id}>
                    <Link
                      href={`/orders/${m.order_id}#milestone-${m.id}`}
                      className="text-blue-600 hover:text-blue-700"
                    >
                      {m.orders?.order_no}
                    </Link>{' '}
                    — {m.name}（到期：{formatDate(m.due_at)}）
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </details>

      <TodayMustHandle milestones={formattedTodayMilestones} />

      {/* Risk Orders: Red / Yellow / Green */}
      <div>
        <h2 className="text-2xl font-semibold mb-4 text-gray-900">订单风险概览</h2>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-lg border-2 border-red-200 bg-red-50 p-4">
            <h3 className="text-lg font-semibold text-red-800 mb-2">🔴 红色风险（{riskRed.length}）</h3>
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {riskRed.length === 0 ? (
                <p className="text-gray-600 text-sm">无</p>
              ) : (
                riskRed.slice(0, 10).map((o: any) => (
                  <Link key={o.id} href={`/orders/${o.id}`} className="block text-sm text-red-800 hover:underline">
                    {o.order_no} — {o.customer_name}
                  </Link>
                ))
              )}
              {riskRed.length > 10 && <p className="text-gray-600 text-xs">共 {riskRed.length} 单，仅示前 10</p>}
            </div>
          </div>
          <div className="rounded-lg border-2 border-yellow-200 bg-yellow-50 p-4">
            <h3 className="text-lg font-semibold text-yellow-800 mb-2">🟡 黄色关注（{riskYellow.length}）</h3>
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {riskYellow.length === 0 ? (
                <p className="text-gray-600 text-sm">无</p>
              ) : (
                riskYellow.slice(0, 10).map((o: any) => (
                  <Link key={o.id} href={`/orders/${o.id}`} className="block text-sm text-yellow-800 hover:underline">
                    {o.order_no} — {o.customer_name}
                  </Link>
                ))
              )}
              {riskYellow.length > 10 && <p className="text-gray-600 text-xs">共 {riskYellow.length} 单</p>}
            </div>
          </div>
          <div className="rounded-lg border-2 border-green-200 bg-green-50 p-4">
            <h3 className="text-lg font-semibold text-green-800 mb-2">🟢 绿色正常（{riskGreen.length}）</h3>
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {riskGreen.length === 0 ? (
                <p className="text-gray-600 text-sm">无</p>
              ) : (
                riskGreen.slice(0, 10).map((o: any) => (
                  <Link key={o.id} href={`/orders/${o.id}`} className="block text-sm text-green-800 hover:underline">
                    {o.order_no} — {o.customer_name}
                  </Link>
                ))
              )}
              {riskGreen.length > 10 && <p className="text-gray-600 text-xs">共 {riskGreen.length} 单</p>}
            </div>
          </div>
        </div>
      </div>

      {/* Pending Delay Approvals */}
      <div id="delay-approvals">
        <h2 className="text-2xl font-semibold mb-4 text-gray-900">待审批延期</h2>
        {!pendingDelayRequests || pendingDelayRequests.length === 0 ? (
          <p className="text-gray-600 bg-gray-50 p-4 rounded">暂无待审批延期</p>
        ) : (
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {(pendingDelayRequests as any[]).map((request: any) => (
              <div key={request.id} className="rounded-lg border border-yellow-200 bg-yellow-50 p-4 text-gray-900">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="font-semibold text-gray-900">{request.milestones?.name || 'Unknown'}</div>
                    <div className="text-sm text-gray-700 mt-1">
                      Order: <Link href={`/orders/${request.milestones?.order_id}`} className="text-blue-600 hover:text-blue-700">{request.milestones?.orders?.order_no}</Link> | Customer: {request.milestones?.orders?.customer_name}
                    </div>
                    <div className="text-sm text-gray-600 mt-1"><strong>Reason:</strong> {request.reason_type}</div>
                    {request.proposed_new_due_at && <div className="text-sm text-gray-600"><strong>Proposed due:</strong> {formatDate(request.proposed_new_due_at)}</div>}
                    <div className="text-xs text-gray-600 mt-2">Created: {formatDate(request.created_at)}</div>
                  </div>
                  <div className="ml-4">
                    <DelayRequestActions delayRequestId={request.id} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Bottleneck leaderboard */}
      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <h2 className="text-2xl font-semibold mb-4 text-gray-900">角色瓶颈榜</h2>
          {Object.keys(bottlenecksByRole).length === 0 ? (
            <p className="text-gray-600 bg-gray-50 p-4 rounded">暂无</p>
          ) : (
            <div className="rounded-lg border border-gray-200 bg-white p-6">
              <table className="w-full text-gray-900">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="text-left py-2 font-semibold">角色</th>
                    <th className="text-left py-2 font-semibold">超期/阻塞数</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(bottlenecksByRole)
                    .sort((a, b) => b[1] - a[1])
                    .map(([role, count]) => (
                      <tr key={role} className="border-b border-gray-200">
                        <td className="py-2 font-medium">{getRoleLabel(role)}</td>
                        <td className="py-2">{count}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div>
          <h2 className="text-2xl font-semibold mb-4 text-gray-900">用户瓶颈榜</h2>
          {Object.keys(bottlenecksByUser).length === 0 ? (
            <p className="text-gray-600 bg-gray-50 p-4 rounded">暂无</p>
          ) : (
            <div className="rounded-lg border border-gray-200 bg-white p-6">
              <table className="w-full text-gray-900">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="text-left py-2 font-semibold">用户</th>
                    <th className="text-left py-2 font-semibold">数量</th>
                    <th className="text-left py-2 font-semibold">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(bottlenecksByUser)
                    .sort((a, b) => b[1].count - a[1].count)
                    .map(([userId, data]) => {
                      const profile = userProfileMap.get(userId);
                      const displayName = profile ? (profile.name || profile.email || userId) : userId === 'unassigned' ? '未分配' : userId;
                      return (
                        <tr key={userId} className="border-b border-gray-200">
                          <td className="py-2 font-medium">{displayName}</td>
                          <td className="py-2">{data.count}</td>
                          <td className="py-2">
                            <Link href={`/orders/${data.milestones[0]?.order_id || '#'}`} className="text-blue-600 hover:text-blue-700 text-sm">查看订单</Link>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
