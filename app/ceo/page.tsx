import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { formatDate, isOverdue } from '@/lib/utils/date';
import { computeOrderStatus } from '@/lib/utils/order-status';
import Link from 'next/link';
import { DelayRequestActions } from '@/components/DelayRequestActions';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import { getRoleLabel } from '@/lib/utils/i18n';
import { getAnalyticsSummary, getRoleEfficiency } from '@/app/actions/analytics';
import { getAllPendingAgentSuggestions } from '@/app/actions/agent-suggestions';
import { AgentSuggestionsPanel } from '@/components/AgentSuggestionCard';
import { getPendingApprovalsCount } from '@/lib/services/pending-approvals.service';
import { CeoInsightButton } from '@/components/CeoInsightButton';
// 邮件晨报（briefing.service / MorningBriefingCard）已下线 — 用户反馈"太费钱用处不大"
// 服务代码保留在 lib/services/briefing.service.ts，仅移除 UI 入口
// RecalcButton removed from global — now per-order only

import { isDoneStatus, isActiveStatus, isBlockedStatus, normalizeMilestoneStatus } from '@/lib/domain/types';
const _isDone = (s: string) => isDoneStatus(s);
const _isActive = (s: string) => isActiveStatus(s);
const _isBlocked = (s: string) => isBlockedStatus(s);
const _isPending = (s: string) => normalizeMilestoneStatus(s) === '未开始';

export default async function CEOWarRoom() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) redirect('/dashboard');

  const { data: ceoProfile } = await supabase.from('profiles').select('name, role, roles').eq('user_id', user.id).single();
  const ceoName = (ceoProfile as any)?.name || user.email?.split('@')[0];
  const ceoRoles: string[] =
    Array.isArray((ceoProfile as any)?.roles) && (ceoProfile as any).roles.length > 0
      ? (ceoProfile as any).roles
      : [(ceoProfile as any)?.role].filter(Boolean);

  // 效率分析数据 + 待审批聚合
  const [analyticsSummary, roleEfficiency, agentResult, approvalsResult] = await Promise.all([
    getAnalyticsSummary(),
    getRoleEfficiency(),
    getAllPendingAgentSuggestions().catch(() => ({ data: [] })),
    getPendingApprovalsCount(supabase, { userId: user.id, roles: ceoRoles }).catch(() => ({ ok: false as const, error: '' })),
  ]);
  const agentSuggestions = agentResult.data || [];
  const approvals = approvalsResult.ok ? approvalsResult.data : { total: 0, byCategory: {} as any, actionableCount: 0 };

  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const twoDaysLater = new Date(now.getTime() + 48 * 60 * 60 * 1000);

  // ===== 数据加载（批量查询，避免 N+1） =====
  const { data: orders } = await supabase.from('orders').select('*').order('created_at', { ascending: false });
  const orderIds = (orders || []).map((o: any) => o.id);
  const { data: allMilestones } = orderIds.length > 0
    ? await supabase.from('milestones').select('*').in('order_id', orderIds)
    : { data: [] };
  // 按 order_id 分组
  const milestonesByOrder = new Map<string, any[]>();
  for (const m of (allMilestones || []) as any[]) {
    const arr = milestonesByOrder.get(m.order_id) || [];
    arr.push(m);
    milestonesByOrder.set(m.order_id, arr);
  }
  const ordersWithMilestones = (orders || []).map((o: any) => ({
    ...o,
    milestones: milestonesByOrder.get(o.id) || [],
  }));

  // 自己订单 vs 协作订单：自己 = 创建者或 owner 为当前用户
  const ownOrderIds = new Set<string>(
    (orders || [])
      .filter((o: any) => o.created_by === user.id || o.owner_user_id === user.id)
      .map((o: any) => o.id)
  );

  // 风险分类（带详细原因）
  const orderStatusMap = new Map<string, ReturnType<typeof computeOrderStatus>>();
  for (const o of ordersWithMilestones) {
    orderStatusMap.set(o.id, computeOrderStatus(o.milestones || []));
  }
  const riskRed = ordersWithMilestones.filter(o => orderStatusMap.get(o.id)?.color === 'RED');
  const riskYellow = ordersWithMilestones.filter(o => orderStatusMap.get(o.id)?.color === 'YELLOW');
  const riskGreen = ordersWithMilestones.filter(o => orderStatusMap.get(o.id)?.color === 'GREEN');

  // 所有超期/卡住里程碑
  const { data: allMilestonesWithOrders } = await (supabase.from('milestones') as any)
    .select(`id, order_id, name, step_key, owner_role, owner_user_id, due_at, status, orders!inner(id, order_no, customer_name, internal_order_no)`)
    .order('due_at', { ascending: true });

  const overdueMilestones = (allMilestonesWithOrders || []).filter((m: any) =>
    _isActive(m.status) && m.due_at && isOverdue(m.due_at)
  );
  const blockedMilestones = (allMilestonesWithOrders || []).filter((m: any) =>
    _isBlocked(m.status)
  );
  const overdueCount = overdueMilestones.length;
  const blockedCount = blockedMilestones.length;

  // 用户信息映射
  const allUserIds = [...new Set([
    ...overdueMilestones.map((m: any) => m.owner_user_id),
    ...blockedMilestones.map((m: any) => m.owner_user_id),
  ].filter(Boolean))] as string[];
  let userMap: Record<string, any> = {};
  if (allUserIds.length > 0) {
    const { data: profiles } = await (supabase.from('profiles') as any)
      .select('user_id, email, name, role, roles').in('user_id', allUserIds);
    if (profiles) userMap = (profiles as any[]).reduce((acc, p) => ({ ...acc, [p.user_id]: p }), {});
  }

  // 待审批延期
  const { data: pendingDelays } = await (supabase.from('delay_requests') as any)
    .select(`*, milestones!inner(id, name, order_id, owner_role, orders!inner(id, order_no, customer_name))`)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  // 明日风险窗口
  const { data: tomorrowRisk } = await (supabase.from('milestones') as any)
    .select(`id, order_id, name, due_at, status, owner_role, orders!inner(id, order_no, customer_name)`)
    .gte('due_at', tomorrow.toISOString())
    .lt('due_at', twoDaysLater.toISOString())
    .not('status', 'in', '("done","已完成","completed")');

  // ===== 今日待办（3 分类：紧急事项 / 风险预警 / 协作提醒） =====
  // 设计原则：每条带 bucket 标签，前端按 bucket 分组渲染
  type TodoBucket = 'urgent' | 'warning' | 'collab';
  interface TopItem {
    id: string;
    priority: number;
    type: 'overdue' | 'blocked' | 'delay' | 'risk_soon';
    typeLabel: string;
    bucket: TodoBucket;
    orderId: string;
    orderNo: string;
    internalOrderNo?: string;
    customerName: string;
    description: string;
    owner: string;
    ownerRole: string;
    daysInfo: string;
  }

  const topItems: TopItem[] = [];
  const orderFocusMs: Record<string, string> = {}; // orderId -> milestone_id 用于跳转定位

  // === 紧急事项（urgent）：超期 ≥3 天 / is_critical 卡住 ===
  // === 风险预警（warning）：超期 1-2 天 / 普通卡住 / 即将到期 ===
  overdueMilestones.slice(0, 30).forEach((m: any) => {
    const dueAt = new Date(m.due_at);
    const daysOver = Math.max(1, Math.ceil((now.getTime() - dueAt.getTime()) / (86400000)));
    const ownerProfile = m.owner_user_id ? userMap[m.owner_user_id] : null;
    if (!orderFocusMs[m.order_id]) orderFocusMs[m.order_id] = m.id;
    const isUrgent = daysOver >= 3 || m.is_critical;
    topItems.push({
      id: `overdue-${m.id}`,
      priority: daysOver * 10 + (m.is_critical ? 50 : 0),
      type: 'overdue',
      typeLabel: '超期',
      bucket: isUrgent ? 'urgent' : 'warning',
      orderId: m.order_id,
      orderNo: m.orders?.order_no || '',
      internalOrderNo: m.orders?.internal_order_no || '',
      customerName: m.orders?.customer_name || '',
      description: m.name,
      owner: ownerProfile?.name || ownerProfile?.email || '未分配',
      ownerRole: getRoleLabel(m.owner_role),
      daysInfo: `已超 ${daysOver} 天`,
    });
  });

  // 卡住节点（is_critical → urgent，其他 → warning）
  blockedMilestones.forEach((m: any) => {
    const ownerProfile = m.owner_user_id ? userMap[m.owner_user_id] : null;
    if (!orderFocusMs[m.order_id]) orderFocusMs[m.order_id] = m.id;
    topItems.push({
      id: `blocked-${m.id}`,
      priority: m.is_critical ? 80 : 30,
      type: 'blocked',
      typeLabel: '卡住',
      bucket: m.is_critical ? 'urgent' : 'warning',
      orderId: m.order_id,
      orderNo: m.orders?.order_no || '',
      internalOrderNo: m.orders?.internal_order_no || '',
      customerName: m.orders?.customer_name || '',
      description: m.name,
      owner: ownerProfile?.name || ownerProfile?.email || '未分配',
      ownerRole: getRoleLabel(m.owner_role),
      daysInfo: '需解除阻塞',
    });
  });

  // 即将到期（48h 内 → 风险预警）
  ((tomorrowRisk as any[]) || []).slice(0, 20).forEach((m: any) => {
    if (!orderFocusMs[m.order_id]) orderFocusMs[m.order_id] = m.id;
    const dueAt = new Date(m.due_at);
    const hoursLeft = Math.max(1, Math.ceil((dueAt.getTime() - now.getTime()) / 3600000));
    topItems.push({
      id: `tomorrow-${m.id}`,
      priority: 20 - hoursLeft / 24, // 越接近到期优先级越高
      type: 'risk_soon',
      typeLabel: '即将到期',
      bucket: 'warning',
      orderId: m.order_id,
      orderNo: m.orders?.order_no || '',
      customerName: m.orders?.customer_name || '',
      description: m.name,
      owner: getRoleLabel(m.owner_role || ''),
      ownerRole: getRoleLabel(m.owner_role || ''),
      daysInfo: hoursLeft <= 24 ? `${hoursLeft}h 后到期` : '明日到期',
    });
  });

  // === 协作提醒（collab）：等待审批 / 上下游协作 ===
  (pendingDelays || []).forEach((d: any) => {
    const createdAt = d.created_at ? new Date(d.created_at) : now;
    const daysPending = Math.max(0, Math.ceil((now.getTime() - createdAt.getTime()) / 86400000));
    topItems.push({
      id: `delay-${d.id}`,
      priority: 40 + daysPending * 5,
      type: 'delay',
      typeLabel: '待审批延期',
      bucket: 'collab',
      orderId: d.milestones?.order_id || '',
      orderNo: d.milestones?.orders?.order_no || '',
      customerName: d.milestones?.orders?.customer_name || '',
      description: `${d.milestones?.name || ''} — ${d.reason_type || '延期申请'}`,
      owner: getRoleLabel(d.milestones?.owner_role || ''),
      ownerRole: getRoleLabel(d.milestones?.owner_role || ''),
      daysInfo: daysPending > 0 ? `等待 ${daysPending} 天` : '今日提交',
    });
  });

  // === 协作风险（前序节点已完成 ≥3 天但下一节点仍未启动） ===
  // 2026-04-28 由独立区块归入风险预警 → 协作订单风险 子栏
  const handoffOrderIds = new Set<string>();
  {
    const DONE_S = new Set(['done', '已完成', 'completed']);
    const PENDING_S = new Set(['pending', '未开始', 'not_started']);
    for (const order of ordersWithMilestones) {
      const ms = [...(order.milestones || [])].sort(
        (a: any, b: any) => (a.sequence_number || 0) - (b.sequence_number || 0)
      );
      for (let i = 0; i < ms.length - 1; i++) {
        const cur = ms[i];
        const next = ms[i + 1];
        if (DONE_S.has(cur.status) && PENDING_S.has(next.status) && cur.actual_at) {
          const days = Math.floor((now.getTime() - new Date(cur.actual_at).getTime()) / 86400000);
          if (days >= 3) {
            const ownerProfile = next.owner_user_id ? userMap[next.owner_user_id] : null;
            const toOwner = ownerProfile?.name || ownerProfile?.email || `${getRoleLabel(next.owner_role)}（未分配）`;
            handoffOrderIds.add(order.id);
            topItems.push({
              id: `handoff-${order.id}-${next.id || next.step_key}`,
              priority: 25 + days,
              type: 'blocked',
              typeLabel: '交接卡顿',
              bucket: 'warning',
              orderId: order.id,
              orderNo: order.order_no,
              customerName: order.customer_name || '',
              description: `${cur.name} → ${next.name}（已停 ${days} 天，待 ${toOwner} 启动）`,
              owner: toOwner,
              ownerRole: getRoleLabel(next.owner_role || ''),
              daysInfo: `已停 ${days} 天`,
            });
          }
        }
      }
    }
  }

  // 红色风险订单中超期最多的 → 保证 AI 说"风险最高"的订单一定出现在 Top 5
  const worstRedOrder = riskRed.sort((a: any, b: any) => {
    const aO = (a.milestones || []).filter((m: any) => _isActive(m.status) && m.due_at && isOverdue(m.due_at)).length;
    const bO = (b.milestones || []).filter((m: any) => _isActive(m.status) && m.due_at && isOverdue(m.due_at)).length;
    return bO - aO;
  })[0];
  if (worstRedOrder) {
    const overdueCount = (worstRedOrder.milestones || []).filter((m: any) => _isActive(m.status) && m.due_at && isOverdue(m.due_at)).length;
    // 如果这个订单的节点不在 topItems 前5，手动加入一条订单级别的条目
    const alreadyInTop = topItems.some(item => item.orderNo === worstRedOrder.order_no);
    if (!alreadyInTop || overdueCount > 0) {
      topItems.push({
        id: `risk-order-${worstRedOrder.id}`,
        priority: 200 + overdueCount * 10, // 订单级别风险优先级最高
        type: 'overdue',
        typeLabel: '高危订单',
        bucket: 'urgent',
        orderId: worstRedOrder.id,
        orderNo: worstRedOrder.order_no,
        internalOrderNo: worstRedOrder.internal_order_no || '',
        customerName: worstRedOrder.customer_name || '',
        description: `${overdueCount} 个节点超期，整体风险最高`,
        owner: '',
        ownerRole: '',
        daysInfo: `${overdueCount} 个超期`,
      });
    }
  }

  // 按订单聚合：同一订单合并显示所有问题（同订单按最高 bucket 归类）
  const BUCKET_RANK: Record<TodoBucket, number> = { urgent: 3, warning: 2, collab: 1 };
  topItems.sort((a, b) => b.priority - a.priority);
  const orderMap = new Map<string, TopItem & { issues: string[]; issueCount: number }>();
  for (const item of topItems) {
    if (!item.orderId) continue;
    const existing = orderMap.get(item.orderId);
    if (existing) {
      existing.issues.push(`${item.typeLabel}：${item.description}`);
      existing.issueCount++;
      if (item.priority > existing.priority) existing.priority = item.priority;
      // 同订单合并到最严重的 bucket
      if (BUCKET_RANK[item.bucket] > BUCKET_RANK[existing.bucket]) {
        existing.bucket = item.bucket;
      }
    } else {
      orderMap.set(item.orderId, {
        ...item,
        issues: [`${item.typeLabel}：${item.description}`],
        issueCount: 1,
      });
    }
  }

  // 不再做 Top 5 限制，按 bucket 分组全部展示（最多每组 10 条）
  // 风险预警进一步拆分为 自己订单 / 协作订单
  // 协作订单 = 非自己拥有的订单 OR 有交接卡顿的订单（handoff 天然属于跨团队协作）
  const allTodos = Array.from(orderMap.values()).sort((a, b) => b.priority - a.priority);
  const warningAll = allTodos.filter(t => t.bucket === 'warning');
  const todosByBucket = {
    urgent:        allTodos.filter(t => t.bucket === 'urgent').slice(0, 10),
    warningSelf:   warningAll.filter(t => ownOrderIds.has(t.orderId) && !handoffOrderIds.has(t.orderId)).slice(0, 10),
    warningCollab: warningAll.filter(t => !ownOrderIds.has(t.orderId) || handoffOrderIds.has(t.orderId)).slice(0, 10),
    collab:        allTodos.filter(t => t.bucket === 'collab').slice(0, 10),
  };
  // 协作提醒（delay 审批）已并入"审批中心"入口，不再计入今日待办总数
  const totalTodos = todosByBucket.urgent.length + todosByBucket.warningSelf.length + todosByBucket.warningCollab.length;
  const top5 = allTodos.slice(0, 5); // 保留旧变量给后面文案用

  // ===== 部门超期统计 =====
  const deptOverdue: Record<string, { count: number; items: any[] }> = {};
  overdueMilestones.forEach((m: any) => {
    const role = m.owner_role || 'unknown';
    if (!deptOverdue[role]) deptOverdue[role] = { count: 0, items: [] };
    deptOverdue[role].count += 1;
    deptOverdue[role].items.push(m);
  });

  // ===== AI 分析建议 =====
  const totalOrders = ordersWithMilestones.length;
  const totalMilestones = (allMilestonesWithOrders || []).length;
  const doneMilestones = (allMilestonesWithOrders || []).filter((m: any) => _isDone(m.status)).length;
  const completionRate = totalMilestones > 0 ? Math.round(doneMilestones / totalMilestones * 100) : 0;

  // 找出问题最多的部门
  const worstDept = Object.entries(deptOverdue).sort((a, b) => b[1].count - a[1].count)[0];
  // 风险最高的订单（复用上面 Top 5 已计算的 worstRedOrder）
  const worstOrder = worstRedOrder;

  // 按订单聚合各类问题
  const ordersWithOverdue = ordersWithMilestones.filter(o =>
    (o.milestones || []).some((m: any) => _isActive(m.status) && m.due_at && isOverdue(m.due_at))
  );
  const ordersWithBlocked = ordersWithMilestones.filter(o =>
    (o.milestones || []).some((m: any) => _isBlocked(m.status))
  );
  const tomorrowOrderCount = new Set((tomorrowRisk || []).map((m: any) => m.order_id)).size;

  // 部门问题按订单聚合
  const deptOrderMap: Record<string, Set<string>> = {};
  for (const m of overdueMilestones as any[]) {
    const role = m.owner_role || 'unknown';
    if (!deptOrderMap[role]) deptOrderMap[role] = new Set();
    deptOrderMap[role].add(m.order_id);
  }
  const worstDeptByOrder = Object.entries(deptOrderMap)
    .map(([role, ordersSet]) => ({ role, orderCount: ordersSet.size }))
    .sort((a, b) => b.orderCount - a.orderCount)[0];

  const aiInsights: string[] = [];
  if (worstDeptByOrder && worstDeptByOrder.orderCount > 0) {
    aiInsights.push(`📌 ${getRoleLabel(worstDeptByOrder.role)}部门涉及 ${worstDeptByOrder.orderCount} 个订单存在超期，建议重点关注。`);
  }
  if (worstOrder) {
    const overdueInOrder = (worstOrder.milestones || []).filter((m: any) => _isActive(m.status) && m.due_at && isOverdue(m.due_at)).length;
    aiInsights.push(`🚨 风险最高订单：${worstOrder.order_no}（${worstOrder.customer_name}），${overdueInOrder} 个节点超期，需要 CEO 介入。`);
  }
  if ((pendingDelays || []).length > 2) {
    const delayOrderCount = new Set((pendingDelays || []).map((d: any) => d.milestones?.order_id)).size;
    aiInsights.push(`⏳ ${delayOrderCount} 个订单有延期申请待审批，建议今日内全部处理。`);
  }
  if (ordersWithBlocked.length > 0) {
    aiInsights.push(`🔒 ${ordersWithBlocked.length} 个订单存在阻塞节点，影响后续流程推进。`);
  }
  if (riskRed.length === 0 && ordersWithOverdue.length === 0) {
    aiInsights.push(`✅ 整体运行良好，无需紧急决策。`);
  }
  if (tomorrowOrderCount > 0) {
    aiInsights.push(`⚡ 未来48小时有 ${tomorrowOrderCount} 个订单的节点即将到期，建议提前跟进。`);
  }

  // ===== 订单三阶段分类（严格按里程碑状态判断，不依赖 lifecycle_status） =====
  // 设计原则：lifecycle_status 经常不及时更新，里程碑状态才是真实推进状态
  const isOrderCompleted = (ls: string) =>
    ls === '已完成' || ls === 'completed' || ls === '待复盘' || ls === '已复盘' || ls === '已取消';

  const hasActiveMilestones = (o: any) =>
    (o.milestones || []).some((m: any) => _isActive(m.status));
  const hasDoneMilestones = (o: any) =>
    (o.milestones || []).some((m: any) => _isDone(m.status));

  // 进行中：未完成且至少有一个里程碑被推进过（进行中 OR 已完成 OR 阻塞）
  const inProgressOrders = ordersWithMilestones.filter(o => {
    const ls = o.lifecycle_status || '';
    if (isOrderCompleted(ls)) return false;
    return hasActiveMilestones(o) || hasDoneMilestones(o) ||
      (o.milestones || []).some((m: any) => _isBlocked(m.status));
  });

  // 新订单：未完成且所有里程碑都还没启动
  const newOrders = ordersWithMilestones.filter(o => {
    const ls = o.lifecycle_status || '';
    if (isOrderCompleted(ls)) return false;
    return !hasActiveMilestones(o) && !hasDoneMilestones(o) &&
      !(o.milestones || []).some((m: any) => _isBlocked(m.status));
  });
  const completedOrders = ordersWithMilestones.filter(o => {
    const ls = o.lifecycle_status || '';
    return ls === '已完成' || ls === 'completed' || ls === '待复盘' || ls === '已复盘';
  });
  // 保留旧分类（兼容）
  const inProgress = ordersWithMilestones.filter(o => {
    const ms = o.milestones || [];
    return ms.some((m: any) => _isActive(m.status)) && !ms.every((m: any) => _isDone(m.status));
  });
  const readyToShip = ordersWithMilestones.filter(o => {
    const ms = o.milestones || [];
    const shipKeys = ['booking_done', 'customs_export'];
    return shipKeys.some(key => ms.find((m: any) => m.step_key === key && _isActive(m.status)));
  });
  const delayed = ordersWithMilestones.filter(o => {
    return (o.milestones || []).some((m: any) => _isActive(m.status) && m.due_at && isOverdue(m.due_at));
  });

  // 新订单分析数据
  const thisMonthNew = newOrders.filter(o => (o.created_at || '').slice(0, 7) === now.toISOString().slice(0, 7));
  const newOrderTotalQty = newOrders.reduce((s: number, o: any) => s + (o.quantity || 0), 0);
  const newCustomers = new Set(newOrders.map((o: any) => o.customer_name).filter(Boolean));

  // 进行中分析
  const overdueInProgress = inProgressOrders.filter(o =>
    (o.milestones || []).some((m: any) => _isActive(m.status) && m.due_at && isOverdue(m.due_at))
  );
  const blockedInProgress = inProgressOrders.filter(o =>
    (o.milestones || []).some((m: any) => _isBlocked(m.status))
  );

  // 已完成复盘
  const needRetrospective = completedOrders.filter(o => o.lifecycle_status === '待复盘');
  const retrospected = completedOrders.filter(o => o.lifecycle_status === '已复盘');

  // ===== 页面渲染 =====
  const TYPE_COLORS: Record<string, string> = {
    overdue: 'bg-red-100 text-red-800 border-red-200',
    blocked: 'bg-orange-100 text-orange-800 border-orange-200',
    delay: 'bg-yellow-100 text-yellow-800 border-yellow-200',
    risk_soon: 'bg-purple-100 text-purple-800 border-purple-200',
  };

  return (
    <div className="min-h-screen bg-gray-50 p-4 md:p-6 space-y-6">
      {/* ===== 欢迎头部 ===== */}
      {(() => {
        const quotes = [
          '今天也要好好吃饭哦，你值得被好好对待。',
          '不管昨天怎样，今天又是崭新的一天，你很棒。',
          '累了就歇一歇，照顾好自己才是最重要的事。',
          '你笑起来真好看，今天也要开开心心的。',
          '记得喝水，记得休息，记得你很重要。',
          '不用完美，做你自己就已经很好了。',
          '有你在的地方，就多了一份安心和温暖。',
          '今天天气不错，抬头看看窗外，深呼吸一下。',
          '你已经很努力了，允许自己偶尔放松一下吧。',
          '每一天都在变好，哪怕只是一点点，也很了不起。',
          '下班后给自己安排一点喜欢的事吧，你值得。',
          '你的存在本身就是一种力量，别忘了这一点。',
          '别太为难自己，很多事情慢慢来就好。',
          '今天也在认真生活的你，辛苦啦。',
          '希望今天的你，能遇到一件让你微笑的小事。',
          '不管多忙，都要记得吃早餐哦。',
          '你比你想象的更坚强，也比你以为的更温柔。',
          '偶尔停下来看看来时的路，你已经走了很远了。',
          '今天也要对自己好一点，你配得上所有美好。',
          '疲惫的时候想想让你开心的人和事，会好很多。',
          '世界很大，但此刻最重要的是你自己。',
          '你的付出都有意义，即使暂时看不到回报。',
          '给自己一个拥抱吧，你一直都很棒。',
          '今天的阳光是为你准备的，好好享受这一天。',
          '不必事事第一，健康快乐就是最好的成绩。',
          '有什么烦心事就放一放，明天又是新的开始。',
          '你的温柔和善良，身边的人都感受得到。',
          '生活不只有眼前的忙碌，还有很多值得期待的事。',
          '此刻的你正在被这个世界温柔以待，请相信。',
          '别忘了，家人朋友一直在你身后支持你。',
          '今天也是值得被好好珍惜的一天，加油鸭。',
        ];
        const dayOfYear = Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86400000);
        const quote = quotes[dayOfYear % quotes.length];
        const greeting = now.getHours() < 12 ? '早上好' : now.getHours() < 18 ? '下午好' : '晚上好';

        return (
          <div className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-slate-50 to-white border border-slate-100 shadow-sm">
            {/* 左侧装饰条 */}
            <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-indigo-300 via-purple-300 to-pink-300" />
            <div className="p-6 pl-7">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-3">
                    <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-gray-800">
                      {greeting}，{ceoName}
                    </h1>
                    <span className="text-2xl">
                      {now.getHours() < 12 ? '🌅' : now.getHours() < 18 ? '☀️' : '🌙'}
                    </span>
                  </div>
                  <p className="mt-3 text-sm text-gray-500 italic leading-relaxed max-w-2xl">
                    {quote}
                  </p>
                  <div className="mt-4 flex items-center gap-4 text-xs text-gray-400">
                    <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-indigo-300" />{totalOrders} 个订单</span>
                    <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-red-300" />{riskRed.length} 个红色风险</span>
                    <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-amber-300" />{ordersWithBlocked.length} 个订单阻塞</span>
                    <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-blue-300" />{new Set((pendingDelays || []).map((d: any) => d.milestones?.order_id)).size} 个订单待审批</span>
                  </div>
                </div>
                <div className="text-right flex-shrink-0 ml-6 space-y-2">
                  <p className="text-sm font-medium text-gray-500">
                    {now.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })}
                  </p>
                  <p className="text-xs text-gray-400">
                    {now.toLocaleDateString('zh-CN', { weekday: 'long' })}
                  </p>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* 状态概览卡片已下线（2026-04-27）— 用户反馈"风险/阻塞/完成率"统计应在数据分析页查看，首页只展示行动 */}

      {/* ===== 1. 今日待办 — 紧急事项 / 自己订单风险 / 协作订单风险 ===== */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-md overflow-hidden">
        <div className="bg-gradient-to-r from-blue-50 to-indigo-50 px-5 py-3 border-b border-gray-200">
          <h2 className="text-lg font-bold text-gray-900">📋 今日待办（共 {totalTodos} 项）</h2>
          <p className="text-xs text-gray-600 mt-0.5">紧急事项 · 自己订单风险 · 协作订单风险</p>
        </div>

        {totalTodos === 0 ? (
          <div className="p-10 text-center">
            <div className="text-4xl mb-2">🎉</div>
            <div className="text-gray-600">今日暂无待办，继续保持！</div>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {/* === 紧急事项 === */}
            {todosByBucket.urgent.length > 0 && (
              <div>
                <div className="bg-red-50 px-5 py-2 border-b border-red-100 flex items-center gap-2">
                  <span className="text-base">🚨</span>
                  <h3 className="text-sm font-bold text-red-900">紧急事项（{todosByBucket.urgent.length}）</h3>
                  <span className="text-xs text-red-600/70">超期 ≥3 天 / 关键节点卡住 / 高危订单</span>
                </div>
                <div className="divide-y divide-gray-100">
                  {todosByBucket.urgent.map((item: any, i: number) => (
                    <div key={item.orderId} className="px-5 py-3 hover:bg-red-50/30 transition-colors">
                      <div className="flex items-center justify-between gap-4">
                        <div className="flex items-start gap-3 flex-1 min-w-0">
                          <span className="text-sm font-bold text-red-600 w-5 text-center flex-shrink-0">{i + 1}</span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <Link href={`/orders/${item.orderId}`} className="font-semibold text-blue-700 hover:underline text-sm">
                                {item.orderNo}
                              </Link>
                              <span className="text-gray-500 text-sm truncate">{item.customerName}</span>
                              <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">
                                {item.issueCount} 个问题
                              </span>
                            </div>
                            <div className="text-xs text-gray-600 mt-1 space-y-0.5">
                              {item.issues.slice(0, 2).map((issue: string, j: number) => (
                                <div key={j}>• {issue}</div>
                              ))}
                              {item.issueCount > 2 && (
                                <div className="text-gray-400">还有 {item.issueCount - 2} 个...</div>
                              )}
                            </div>
                          </div>
                        </div>
                        <Link
                          href={orderFocusMs[item.orderId]
                            ? `/orders/${item.orderId}?tab=progress&focus=${orderFocusMs[item.orderId]}&from=/ceo`
                            : `/orders/${item.orderId}?tab=progress&from=/ceo`}
                          className="flex-shrink-0 bg-red-600 text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-red-700"
                        >
                          去处理
                        </Link>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* === 风险预警 — 自己订单 === */}
            {todosByBucket.warningSelf.length > 0 && (
              <div>
                <div className="bg-amber-50 px-5 py-2 border-b border-amber-100 flex items-center gap-2">
                  <span className="text-base">⚠️</span>
                  <h3 className="text-sm font-bold text-amber-900">自己订单风险（{todosByBucket.warningSelf.length}）</h3>
                  <span className="text-xs text-amber-600/70">你创建/负责的订单</span>
                </div>
                <div className="divide-y divide-gray-100">
                  {todosByBucket.warningSelf.map((item: any, i: number) => (
                    <div key={item.orderId} className="px-5 py-3 hover:bg-amber-50/30 transition-colors">
                      <div className="flex items-center justify-between gap-4">
                        <div className="flex items-start gap-3 flex-1 min-w-0">
                          <span className="text-sm font-bold text-amber-600 w-5 text-center flex-shrink-0">{i + 1}</span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <Link href={`/orders/${item.orderId}`} className="font-semibold text-blue-700 hover:underline text-sm">
                                {item.orderNo}
                              </Link>
                              <span className="text-gray-500 text-sm truncate">{item.customerName}</span>
                              <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">
                                {item.issueCount} 项
                              </span>
                            </div>
                            <div className="text-xs text-gray-600 mt-1 space-y-0.5">
                              {item.issues.slice(0, 2).map((issue: string, j: number) => (
                                <div key={j}>• {issue}</div>
                              ))}
                              {item.issueCount > 2 && (
                                <div className="text-gray-400">还有 {item.issueCount - 2} 个...</div>
                              )}
                            </div>
                          </div>
                        </div>
                        <Link
                          href={orderFocusMs[item.orderId]
                            ? `/orders/${item.orderId}?tab=progress&focus=${orderFocusMs[item.orderId]}&from=/ceo`
                            : `/orders/${item.orderId}?tab=progress&from=/ceo`}
                          className="flex-shrink-0 bg-amber-500 text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-amber-600"
                        >
                          查看
                        </Link>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* === 风险预警 — 协作订单 === */}
            {todosByBucket.warningCollab.length > 0 && (
              <div>
                <div className="bg-orange-50 px-5 py-2 border-b border-orange-100 flex items-center gap-2">
                  <span className="text-base">🤝</span>
                  <h3 className="text-sm font-bold text-orange-900">协作订单风险（{todosByBucket.warningCollab.length}）</h3>
                  <span className="text-xs text-orange-600/70">他人负责的订单 / 上下游交接卡顿</span>
                </div>
                <div className="divide-y divide-gray-100">
                  {todosByBucket.warningCollab.map((item: any, i: number) => (
                    <div key={item.orderId} className="px-5 py-3 hover:bg-orange-50/30 transition-colors">
                      <div className="flex items-center justify-between gap-4">
                        <div className="flex items-start gap-3 flex-1 min-w-0">
                          <span className="text-sm font-bold text-orange-600 w-5 text-center flex-shrink-0">{i + 1}</span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <Link href={`/orders/${item.orderId}`} className="font-semibold text-blue-700 hover:underline text-sm">
                                {item.orderNo}
                              </Link>
                              <span className="text-gray-500 text-sm truncate">{item.customerName}</span>
                              <span className="text-xs px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 font-medium">
                                {item.issueCount} 项
                              </span>
                            </div>
                            <div className="text-xs text-gray-600 mt-1 space-y-0.5">
                              {item.issues.slice(0, 2).map((issue: string, j: number) => (
                                <div key={j}>• {issue}</div>
                              ))}
                              {item.issueCount > 2 && (
                                <div className="text-gray-400">还有 {item.issueCount - 2} 个...</div>
                              )}
                            </div>
                          </div>
                        </div>
                        <Link
                          href={orderFocusMs[item.orderId]
                            ? `/orders/${item.orderId}?tab=progress&focus=${orderFocusMs[item.orderId]}&from=/ceo`
                            : `/orders/${item.orderId}?tab=progress&from=/ceo`}
                          className="flex-shrink-0 bg-orange-500 text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-orange-600"
                        >
                          查看
                        </Link>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ===== 2. 审批中心入口（点击整体进入） ===== */}
      <Link
        href="/admin/pending-approvals"
        className="block bg-white rounded-xl border border-yellow-200 shadow-sm overflow-hidden hover:shadow-md hover:border-yellow-300 transition-all"
      >
        <div className="bg-yellow-50 px-5 py-3 border-b border-yellow-100 flex items-center justify-between">
          <h2 className="text-lg font-bold text-yellow-900">
            ⏳ 审批中心（共 {approvals.total} 项）
          </h2>
          <span className="text-sm text-blue-600 font-medium">→</span>
        </div>
        {approvals.total > 0 ? (
          <div className="px-5 py-3 flex flex-wrap gap-2 bg-gradient-to-r from-purple-50/30 to-indigo-50/30">
            {(approvals.byCategory.delay || 0) > 0 && (
              <span className="text-xs px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
                ⏳ 延期申请 {approvals.byCategory.delay}
              </span>
            )}
            {(approvals.byCategory.ceo_import || 0) > 0 && (
              <span className="text-xs px-2.5 py-1 rounded-full bg-purple-50 text-purple-700 border border-purple-200 font-semibold">
                👨‍💼 CEO 批进行中订单 {approvals.byCategory.ceo_import}
              </span>
            )}
            {(approvals.byCategory.price || 0) > 0 && (
              <span className="text-xs px-2.5 py-1 rounded-full bg-green-50 text-green-700 border border-green-200">
                💰 价格审批 {approvals.byCategory.price}
              </span>
            )}
            {(approvals.byCategory.agent_action || 0) > 0 && (
              <span className="text-xs px-2.5 py-1 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
                🤖 Agent 建议 {approvals.byCategory.agent_action}
              </span>
            )}
            {(approvals.byCategory.order_confirm || 0) > 0 && (
              <span className="text-xs px-2.5 py-1 rounded-full bg-cyan-50 text-cyan-700 border border-cyan-200">
                📋 订单确认 {approvals.byCategory.order_confirm}
              </span>
            )}
            {(approvals.byCategory.payment_hold || 0) > 0 && (
              <span className="text-xs px-2.5 py-1 rounded-full bg-rose-50 text-rose-700 border border-rose-200">
                💳 付款冻结 {approvals.byCategory.payment_hold}
              </span>
            )}
          </div>
        ) : (
          <div className="p-4 text-center text-gray-400 text-sm">暂无待审批事项</div>
        )}
      </Link>

      {/* 执行力快报、AI 智能助手已下线（2026-04-27）— 数据请去 /analytics/execution 查看 */}

      {/* ===== 4. 订单三阶段分析 ===== */}
      <div className="grid md:grid-cols-3 gap-4">

        {/* 新订单分析 & 接单建议 */}
        <div className="bg-white rounded-xl border border-indigo-200 shadow-sm overflow-hidden">
          <div className="bg-indigo-50 px-4 py-3 border-b border-indigo-100">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-indigo-900">📥 新订单分析</h3>
              <span className="text-xl font-bold text-indigo-600">{newOrders.length}</span>
            </div>
            <p className="text-xs text-indigo-600 mt-0.5">待启动 / 已生效未执行</p>
          </div>
          <div className="p-4 space-y-3">
            <div className="grid grid-cols-2 gap-2 text-center">
              <div className="bg-indigo-50/50 rounded-lg p-2">
                <div className="text-lg font-bold text-indigo-700">{thisMonthNew.length}</div>
                <div className="text-xs text-gray-500">本月新增</div>
              </div>
              <div className="bg-indigo-50/50 rounded-lg p-2">
                <div className="text-lg font-bold text-indigo-700">{newOrderTotalQty.toLocaleString()}</div>
                <div className="text-xs text-gray-500">待排产件数</div>
              </div>
            </div>
            <div className="text-xs text-gray-500">涉及 <span className="font-medium text-gray-700">{newCustomers.size}</span> 个客户</div>
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {newOrders.map((o: any) => (
                <Link key={o.id} href={`/orders/${o.id}`} className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-indigo-50 text-sm group">
                  <span className="truncate">
                    <span className="font-medium text-gray-900">{o.order_no}</span>
                    <span className="text-gray-500 ml-1">{o.customer_name}</span>
                  </span>
                  <span className="text-xs text-gray-400 shrink-0 ml-2">{o.quantity ? `${o.quantity}件` : ''}</span>
                </Link>
              ))}
              {newOrders.length === 0 && <p className="text-sm text-gray-400 text-center py-2">暂无新订单</p>}
            </div>
            {newOrders.length > 0 && (
              <CeoInsightButton orders={newOrders.map((o: any) => ({
                order_no: o.order_no,
                customer_name: o.customer_name,
                order_type: o.order_type,
                quantity: o.quantity ?? null,
                factory_date: o.factory_date ?? null,
                incoterm: o.incoterm,
                created_at: o.created_at,
              }))} />
            )}
          </div>
        </div>

        {/* 进行中订单 */}
        <div className="bg-white rounded-xl border border-blue-200 shadow-sm overflow-hidden">
          <div className="bg-blue-50 px-4 py-3 border-b border-blue-100">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-blue-900">🔄 进行中订单</h3>
              <span className="text-xl font-bold text-blue-600">{inProgressOrders.length}</span>
            </div>
            <p className="text-xs text-blue-600 mt-0.5">执行中 · 各节点推进状态</p>
          </div>
          <div className="p-4 space-y-3">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="bg-blue-50/50 rounded-lg p-2">
                <div className="text-lg font-bold text-blue-700">{inProgressOrders.length}</div>
                <div className="text-xs text-gray-500">执行中</div>
              </div>
              <div className="bg-red-50/50 rounded-lg p-2">
                <div className="text-lg font-bold text-red-600">{overdueInProgress.length}</div>
                <div className="text-xs text-gray-500">有超期</div>
              </div>
              <div className="bg-orange-50/50 rounded-lg p-2">
                <div className="text-lg font-bold text-orange-600">{blockedInProgress.length}</div>
                <div className="text-xs text-gray-500">有阻塞</div>
              </div>
            </div>
            {/* 风险 Top 3 */}
            {(() => {
              const riskyInProgress = inProgressOrders
                .filter(o => {
                  const c = orderStatusMap.get(o.id)?.color;
                  return c === 'RED' || c === 'YELLOW';
                })
                .sort((a: any, b: any) => {
                  const colorScore = (o: any) => orderStatusMap.get(o.id)?.color === 'RED' ? 100 : 10;
                  const overdueScore = (o: any) => (o.milestones || []).filter((m: any) => _isActive(m.status) && m.due_at && isOverdue(m.due_at)).length;
                  return (colorScore(b) + overdueScore(b)) - (colorScore(a) + overdueScore(a));
                })
                .slice(0, 3);
              if (riskyInProgress.length === 0) return null;
              return (
                <div>
                  <p className="text-xs font-medium text-red-700 mb-1">🔥 风险 Top {riskyInProgress.length}</p>
                  <div className="space-y-1">
                    {riskyInProgress.map((o: any) => {
                      const status = orderStatusMap.get(o.id);
                      const badge = status?.color === 'RED' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700';
                      const dot = status?.color === 'RED' ? '🔴' : '🟡';
                      return (
                        <Link key={o.id} href={`/orders/${o.id}?tab=progress`}
                          className="flex items-center gap-2 text-xs px-2 py-1.5 rounded bg-red-50 hover:bg-red-100">
                          <span className="shrink-0">{dot}</span>
                          <span className="font-medium truncate">{o.order_no}</span>
                          <span className={`shrink-0 text-[10px] px-1.5 rounded ${badge}`}>
                            {status?.riskFactors?.[0]?.slice(0, 10) || status?.reason?.slice(0, 10) || '风险'}
                          </span>
                        </Link>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {overdueInProgress.length > 0 && (
              <div>
                <p className="text-xs font-medium text-red-700 mb-1">超期订单：</p>
                <div className="space-y-1 max-h-24 overflow-y-auto">
                  {overdueInProgress.map((o: any) => (
                    <Link key={o.id} href={`/orders/${o.id}?tab=progress`} className="block text-sm text-red-700 hover:text-red-900 truncate px-2">
                      {o.order_no} — {o.customer_name}
                    </Link>
                  ))}
                </div>
              </div>
            )}

            {/* 分批出货中 */}
            {(() => {
              const splitOrders = inProgressOrders.filter(o =>
                Array.isArray(o.special_tags) && o.special_tags.includes('分批出货中')
              );
              if (splitOrders.length === 0) return null;
              return (
                <div>
                  <p className="text-xs font-medium text-purple-700 mb-1">📦 分批出货中（{splitOrders.length}）</p>
                  <div className="space-y-1">
                    {splitOrders.map((o: any) => (
                      <Link key={o.id} href={`/orders/${o.id}`}
                        className="flex items-center justify-between text-xs px-2 py-1.5 rounded bg-purple-50 hover:bg-purple-100">
                        <span className="font-medium truncate">{o.order_no}</span>
                        <span className="text-gray-500 shrink-0 ml-1">{o.customer_name}</span>
                      </Link>
                    ))}
                  </div>
                </div>
              );
            })()}

            <div className="space-y-1 max-h-32 overflow-y-auto">
              {inProgressOrders.filter(o => !overdueInProgress.includes(o)).slice(0, 8).map((o: any) => (
                <Link key={o.id} href={`/orders/${o.id}`} className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-blue-50 text-sm">
                  <span className="truncate">
                    <span className="font-medium text-gray-900">{o.order_no}</span>
                    <span className="text-gray-500 ml-1">{o.customer_name}</span>
                  </span>
                  <span className="text-xs text-gray-400 shrink-0 ml-2">{o.quantity ? `${o.quantity}件` : ''}</span>
                </Link>
              ))}
            </div>
          </div>
        </div>

        {/* 已完成订单复盘 */}
        <div className="bg-white rounded-xl border border-green-200 shadow-sm overflow-hidden">
          <div className="bg-green-50 px-4 py-3 border-b border-green-100">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-green-900">✅ 已完成 & 复盘</h3>
              <span className="text-xl font-bold text-green-600">{completedOrders.length}</span>
            </div>
            <p className="text-xs text-green-600 mt-0.5">已完成订单 · 待复盘 / 已复盘</p>
          </div>
          <div className="p-4 space-y-3">
            <div className="grid grid-cols-2 gap-2 text-center">
              <div className="bg-amber-50/50 rounded-lg p-2">
                <div className="text-lg font-bold text-amber-700">{needRetrospective.length}</div>
                <div className="text-xs text-gray-500">待复盘</div>
              </div>
              <div className="bg-green-50/50 rounded-lg p-2">
                <div className="text-lg font-bold text-green-700">{retrospected.length}</div>
                <div className="text-xs text-gray-500">已复盘</div>
              </div>
            </div>
            {needRetrospective.length > 0 && (
              <div>
                <p className="text-xs font-medium text-amber-700 mb-1">待复盘订单：</p>
                <div className="space-y-1 max-h-24 overflow-y-auto">
                  {needRetrospective.map((o: any) => (
                    <Link key={o.id} href={`/orders/${o.id}/retrospective`} className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-amber-50 text-sm group">
                      <span className="truncate">
                        <span className="font-medium text-gray-900">{o.order_no}</span>
                        <span className="text-gray-500 ml-1">{o.customer_name}</span>
                      </span>
                      <span className="text-xs text-amber-600 font-medium">去复盘 →</span>
                    </Link>
                  ))}
                </div>
              </div>
            )}
            {completedOrders.length > 0 && (
              <div className="pt-2 border-t border-gray-100">
                <p className="text-xs text-green-700 font-medium">📊 完成概览</p>
                <p className="text-xs text-gray-600 mt-1">
                  共完成 {completedOrders.length} 单，
                  {retrospected.length > 0 ? `已复盘 ${retrospected.length} 单` : ''}
                  {needRetrospective.length > 0 ? `，${needRetrospective.length} 单待复盘` : ''}
                  {needRetrospective.length === 0 && retrospected.length === 0 ? '暂无复盘记录' : ''}
                </p>
              </div>
            )}
            {completedOrders.length === 0 && <p className="text-sm text-gray-400 text-center py-2">暂无已完成订单</p>}
          </div>
        </div>
      </div>

      {/* 明日风险预警 / 协作风险提醒 已下线（2026-04-28）— 已并入"今日待办"中的"自己/协作订单风险"两栏 */}
      {/* 风险订单列表已移至独立页面 /risk-orders/[type]，点击顶部数字卡片进入 */}
      {/* 部门超期/堵点已移至数据分析页 /analytics */}
    </div>
  );
}
