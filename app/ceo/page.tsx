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

  const { data: ceoProfile } = await supabase.from('profiles').select('name').eq('user_id', user.id).single();
  const ceoName = (ceoProfile as any)?.name || user.email?.split('@')[0];

  // 效率分析数据
  const [analyticsSummary, roleEfficiency, agentResult] = await Promise.all([
    getAnalyticsSummary(),
    getRoleEfficiency(),
    getAllPendingAgentSuggestions().catch(() => ({ data: [] })),
  ]);
  const agentSuggestions = agentResult.data || [];

  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const twoDaysLater = new Date(now.getTime() + 48 * 60 * 60 * 1000);

  // ===== 数据加载 =====
  const { data: orders } = await supabase.from('orders').select('*').order('created_at', { ascending: false });
  const ordersWithMilestones: any[] = [];
  if (orders) {
    for (const o of orders as any[]) {
      const { data: milestones } = await supabase.from('milestones').select('*').eq('order_id', o.id);
      ordersWithMilestones.push({ ...o, milestones: milestones || [] });
    }
  }

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

  // ===== 今日 Top 5 必须处理 =====
  interface TopItem {
    id: string;
    priority: number;
    type: 'overdue' | 'blocked' | 'delay' | 'risk_soon';
    typeLabel: string;
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

  // 超期节点（优先级最高）
  overdueMilestones.slice(0, 20).forEach((m: any) => {
    const dueAt = new Date(m.due_at);
    const daysOver = Math.max(1, Math.ceil((now.getTime() - dueAt.getTime()) / (86400000)));
    const ownerProfile = m.owner_user_id ? userMap[m.owner_user_id] : null;
    if (!orderFocusMs[m.order_id]) orderFocusMs[m.order_id] = m.id;
    topItems.push({
      id: `overdue-${m.id}`,
      priority: daysOver * 10 + (m.is_critical ? 5 : 0),
      type: 'overdue',
      typeLabel: '超期',
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

  // 卡住节点
  blockedMilestones.forEach((m: any) => {
    const ownerProfile = m.owner_user_id ? userMap[m.owner_user_id] : null;
    if (!orderFocusMs[m.order_id]) orderFocusMs[m.order_id] = m.id;
    topItems.push({
      id: `blocked-${m.id}`,
      priority: 50,
      type: 'blocked',
      typeLabel: '卡住',
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

  // 待审批延期
  (pendingDelays || []).forEach((d: any) => {
    const createdAt = d.created_at ? new Date(d.created_at) : now;
    const daysPending = Math.max(0, Math.ceil((now.getTime() - createdAt.getTime()) / 86400000));
    topItems.push({
      id: `delay-${d.id}`,
      priority: 40 + daysPending * 5,
      type: 'delay',
      typeLabel: '待审批',
      orderId: d.milestones?.order_id || '',
      orderNo: d.milestones?.orders?.order_no || '',
      customerName: d.milestones?.orders?.customer_name || '',
      description: `${d.milestones?.name || ''} — ${d.reason_type || '延期申请'}`,
      owner: getRoleLabel(d.milestones?.owner_role || ''),
      ownerRole: getRoleLabel(d.milestones?.owner_role || ''),
      daysInfo: daysPending > 0 ? `等待 ${daysPending} 天` : '今日提交',
    });
  });

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

  // 按订单聚合：同一订单合并显示所有问题
  topItems.sort((a, b) => b.priority - a.priority);
  const orderMap = new Map<string, TopItem & { issues: string[]; issueCount: number }>();
  for (const item of topItems) {
    if (!item.orderId) continue;
    const existing = orderMap.get(item.orderId);
    if (existing) {
      existing.issues.push(`${item.typeLabel}：${item.description}`);
      existing.issueCount++;
      if (item.priority > existing.priority) existing.priority = item.priority;
    } else {
      orderMap.set(item.orderId, {
        ...item,
        issues: [`${item.typeLabel}：${item.description}`],
        issueCount: 1,
      });
    }
  }
  const top5 = Array.from(orderMap.values())
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 5);

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

  // ===== 订单三阶段分类 =====
  const newOrders = ordersWithMilestones.filter(o => {
    const ls = o.lifecycle_status || '';
    return ls === 'draft' || ls === '草稿' || ls === 'active' || ls === '已生效';
  });
  const inProgressOrders = ordersWithMilestones.filter(o => {
    const ls = o.lifecycle_status || '';
    return ls === '执行中' || ls === 'running';
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

      {/* ===== 状态概览卡片（点击进入独立页面） ===== */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Link href="/risk-orders/red" className="bg-white rounded-xl border border-gray-200 p-4 text-center hover:border-red-300 hover:shadow-md transition-all cursor-pointer">
          <div className="text-3xl font-bold text-red-600">{riskRed.length}</div>
          <div className="text-xs text-gray-500 mt-1">🔴 红色风险</div>
        </Link>
        <Link href="/risk-orders/yellow" className="bg-white rounded-xl border border-gray-200 p-4 text-center hover:border-yellow-300 hover:shadow-md transition-all cursor-pointer">
          <div className="text-3xl font-bold text-yellow-600">{riskYellow.length}</div>
          <div className="text-xs text-gray-500 mt-1">🟡 黄色关注</div>
        </Link>
        <Link href="/risk-orders/green" className="bg-white rounded-xl border border-gray-200 p-4 text-center hover:border-green-300 hover:shadow-md transition-all cursor-pointer">
          <div className="text-3xl font-bold text-green-600">{riskGreen.length}</div>
          <div className="text-xs text-gray-500 mt-1">🟢 绿色正常</div>
        </Link>
        <Link href="/risk-orders/blocked" className="bg-white rounded-xl border border-gray-200 p-4 text-center hover:border-orange-300 hover:shadow-md transition-all cursor-pointer">
          <div className="text-3xl font-bold text-orange-600">{ordersWithBlocked.length}</div>
          <div className="text-xs text-gray-500 mt-1">🔒 阻塞中</div>
        </Link>
        <div className="bg-white rounded-xl border border-gray-200 p-4 text-center">
          <div className="text-3xl font-bold text-indigo-600">{completionRate}%</div>
          <div className="text-xs text-gray-500 mt-1">📊 完成率</div>
        </div>
      </div>

      {/* ===== 1. 今日必做 — 按订单聚合 ===== */}
      <div className="bg-white rounded-xl border-2 border-red-200 shadow-md overflow-hidden">
        <div className="bg-gradient-to-r from-red-50 to-orange-50 px-5 py-3 border-b border-red-100">
          <h2 className="text-lg font-bold text-red-900">🎯 今日必做事项（Top {top5.length}）</h2>
          <p className="text-xs text-red-700 mt-0.5">按订单聚合，每单一行，点击直接定位到要处理的节点</p>
        </div>
        {top5.length === 0 ? (
          <div className="p-8 text-center">
            <div className="text-4xl mb-2">🎉</div>
            <div className="text-gray-600">今日暂无紧急事项，继续保持！</div>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {top5.map((item: any, i: number) => (
              <div key={item.orderId} className="px-5 py-4 hover:bg-gray-50 transition-colors">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    <span className="text-lg font-bold text-red-600 w-6 text-center flex-shrink-0">
                      {i + 1}
                    </span>
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
                      <div className="text-sm text-gray-700 mt-1 space-y-0.5">
                        {item.issues.slice(0, 3).map((issue: string, j: number) => (
                          <div key={j} className="text-xs text-gray-600">• {issue}</div>
                        ))}
                        {item.issueCount > 3 && (
                          <div className="text-xs text-gray-400">还有 {item.issueCount - 3} 个问题...</div>
                        )}
                      </div>
                    </div>
                  </div>
                  <Link
                    href={
                      item.type === 'delay'
                        ? `/ceo#delay-approvals`
                        : orderFocusMs[item.orderId]
                          ? `/orders/${item.orderId}?tab=progress&focus=${orderFocusMs[item.orderId]}&from=/ceo`
                          : `/orders/${item.orderId}?tab=progress&from=/ceo`
                    }
                    className="flex-shrink-0 bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-700 transition-colors"
                  >
                    去处理
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ===== 2. 待审批延期 ===== */}
      <div id="delay-approvals" className="bg-white rounded-xl border border-yellow-200 shadow-sm overflow-hidden">
        <div className="bg-yellow-50 px-5 py-3 border-b border-yellow-100">
          <h2 className="text-lg font-bold text-yellow-900">⏳ 待审批延期（{(pendingDelays || []).length}）</h2>
        </div>
        {!pendingDelays || pendingDelays.length === 0 ? (
          <div className="p-6 text-center text-gray-500 text-sm">暂无待审批延期</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {(pendingDelays as any[]).map((request: any) => (
              <div key={request.id} className="px-5 py-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-gray-900">{request.milestones?.name}</span>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                        {getRoleLabel(request.milestones?.owner_role || '')}
                      </span>
                    </div>
                    <div className="text-sm text-gray-600 mt-1">
                      <Link href={`/orders/${request.milestones?.order_id}`} className="text-blue-600 hover:underline">
                        {request.milestones?.orders?.order_no}
                      </Link>
                      {' · '}{request.milestones?.orders?.customer_name}
                    </div>
                    <div className="text-sm text-gray-600 mt-1">原因：{request.reason_type}</div>
                    {request.proposed_new_due_at && (
                      <div className="text-sm text-gray-600">申请推迟至：{formatDate(request.proposed_new_due_at)}</div>
                    )}
                  </div>
                  <DelayRequestActions delayRequestId={request.id} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ===== 2.5 执行力快报 ===== */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="text-lg">⚡</span>
            <h2 className="text-base font-bold text-gray-900">执行力快报</h2>
          </div>
          <Link href="/analytics/execution" className="text-xs text-indigo-600 hover:text-indigo-700">
            查看详情 →
          </Link>
        </div>
        <div className="grid grid-cols-4 gap-3 text-center">
          <div className="bg-indigo-50 rounded-lg p-3">
            <div className="text-2xl font-bold text-indigo-600">{overdueCount}</div>
            <div className="text-[10px] text-gray-500">逾期节点</div>
          </div>
          <div className="bg-amber-50 rounded-lg p-3">
            <div className="text-2xl font-bold text-amber-600">{blockedCount}</div>
            <div className="text-[10px] text-gray-500">阻塞节点</div>
          </div>
          <div className="bg-green-50 rounded-lg p-3">
            <div className="text-2xl font-bold text-green-600">{analyticsSummary.thisWeekCompleted || 0}</div>
            <div className="text-[10px] text-gray-500">本周完成</div>
          </div>
          <div className="bg-purple-50 rounded-lg p-3">
            <div className="text-2xl font-bold text-purple-600">{analyticsSummary.completedOrders || 0}</div>
            <div className="text-[10px] text-gray-500">累计完成订单</div>
          </div>
        </div>
      </div>

      {/* ===== 3. AI 智能助手（合并 AI 分析建议 + Agent 智能建议） ===== */}
      <div className="bg-white rounded-xl border-2 border-indigo-200 shadow-md overflow-hidden">
        <div className="bg-gradient-to-r from-indigo-50 to-purple-50 px-5 py-3 border-b border-indigo-100">
          <h2 className="text-lg font-bold text-indigo-900">🤖 AI 智能助手</h2>
          <p className="text-xs text-indigo-600 mt-0.5">实时分析 + 可执行建议</p>
        </div>
        {aiInsights.length > 0 && (
          <div className="p-5 space-y-2 border-b border-indigo-100">
            {aiInsights.map((insight, i) => (
              <div key={i} className="text-sm text-gray-800 leading-relaxed">{insight}</div>
            ))}
          </div>
        )}
        {agentSuggestions.length > 0 && (
          <div className="p-2">
            <AgentSuggestionsPanel
              suggestions={agentSuggestions}
              title=""
              showOrder={true}
            />
          </div>
        )}
        {aiInsights.length === 0 && agentSuggestions.length === 0 && (
          <div className="p-6 text-center text-gray-400 text-sm">✨ 当前无智能建议</div>
        )}
      </div>

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
              <div className="pt-2 border-t border-gray-100">
                <p className="text-xs text-indigo-700 font-medium">💡 接单建议</p>
                <p className="text-xs text-gray-600 mt-1">
                  {newOrders.length >= 5
                    ? '新订单较多，建议优先确认工厂产能和原料到位情况，避免扎堆上线。'
                    : newOrders.length >= 2
                    ? '新订单适量，建议按交期紧急程度排序启动。'
                    : '新订单较少，可考虑主动联系客户开发新单。'}
                </p>
              </div>
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

      {/* ===== 5. 明日风险预警（按订单聚合 + 提前协作提醒） ===== */}
      {(() => {
        // 按订单聚合明日风险节点
        const tomorrowOrderMap = new Map<string, { orderNo: string; customerName: string; orderId: string; nodes: any[]; owners: Set<string> }>();
        for (const m of (tomorrowRisk || []) as any[]) {
          const orderId = m.order_id;
          const ownerProfile = m.owner_user_id ? userMap[m.owner_user_id] : null;
          const ownerName = ownerProfile?.name || ownerProfile?.email || '未分配';
          const existing = tomorrowOrderMap.get(orderId);
          if (existing) {
            existing.nodes.push(m);
            if (ownerName !== '未分配') existing.owners.add(`${ownerName}（${getRoleLabel(m.owner_role)}）`);
          } else {
            tomorrowOrderMap.set(orderId, {
              orderNo: m.orders?.order_no || '',
              customerName: m.orders?.customer_name || '',
              orderId,
              nodes: [m],
              owners: new Set(ownerName !== '未分配' ? [`${ownerName}（${getRoleLabel(m.owner_role)}）`] : []),
            });
          }
        }

        if (tomorrowOrderMap.size === 0) return null;

        return (
          <div className="bg-white rounded-xl border-2 border-purple-200 shadow-md overflow-hidden">
            <div className="bg-gradient-to-r from-purple-50 to-pink-50 px-5 py-3 border-b border-purple-100">
              <h2 className="text-lg font-bold text-purple-900">⚡ 明日风险预警（{tomorrowOrderMap.size} 个订单需要关注）</h2>
              <p className="text-xs text-purple-600 mt-0.5">未来48小时即将到期，已自动通知相关负责人</p>
            </div>
            <div className="divide-y divide-gray-100">
              {Array.from(tomorrowOrderMap.values()).map(info => (
                <div key={info.orderId} className="px-5 py-3 hover:bg-purple-50/30">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <Link href={`/orders/${info.orderId}`} className="font-semibold text-purple-700 hover:underline text-sm">
                          {info.orderNo}
                        </Link>
                        <span className="text-gray-500 text-sm">{info.customerName}</span>
                        <span className="text-xs px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">{info.nodes.length}个节点</span>
                      </div>
                      <div className="text-xs text-gray-600 mt-1">
                        <span className="text-gray-500">节点：</span>
                        {info.nodes.slice(0, 3).map((n: any) => n.name).join('、')}
                        {info.nodes.length > 3 && '...'}
                      </div>
                      {info.owners.size > 0 && (
                        <div className="text-xs text-gray-500 mt-0.5">
                          👥 协作：{Array.from(info.owners).join(' · ')}
                        </div>
                      )}
                    </div>
                    <Link
                      href={`/orders/${info.orderId}?tab=progress&from=/ceo`}
                      className="text-xs px-3 py-1.5 rounded bg-purple-600 text-white hover:bg-purple-700"
                    >
                      去查看
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* ===== 6. 协作风险提醒（上下游协作） ===== */}
      {(() => {
        // 找出"前置节点已完成但下一节点还未启动"的协作断点
        const collabRisks: Array<{ orderNo: string; orderId: string; customerName: string; from: string; to: string; toOwner: string; daysSince: number }> = [];

        for (const order of ordersWithMilestones) {
          const ms = (order.milestones || []).sort((a: any, b: any) =>
            ((a.sequence_number || 0) - (b.sequence_number || 0))
          );
          for (let i = 0; i < ms.length - 1; i++) {
            const cur = ms[i];
            const next = ms[i + 1];
            if (_isDone(cur.status) && _isPending(next.status) && cur.actual_at) {
              const daysSince = Math.floor((now.getTime() - new Date(cur.actual_at).getTime()) / 86400000);
              if (daysSince >= 1) {
                const ownerProfile = next.owner_user_id ? userMap[next.owner_user_id] : null;
                collabRisks.push({
                  orderNo: order.order_no,
                  orderId: order.id,
                  customerName: order.customer_name || '',
                  from: cur.name,
                  to: next.name,
                  toOwner: ownerProfile?.name || ownerProfile?.email || `${getRoleLabel(next.owner_role)}（未分配）`,
                  daysSince,
                });
              }
            }
          }
        }

        if (collabRisks.length === 0) return null;

        return (
          <div className="bg-white rounded-xl border-2 border-amber-200 shadow-md overflow-hidden">
            <div className="bg-gradient-to-r from-amber-50 to-orange-50 px-5 py-3 border-b border-amber-100">
              <h2 className="text-lg font-bold text-amber-900">🤝 协作风险提醒（{collabRisks.length} 个交接卡顿）</h2>
              <p className="text-xs text-amber-600 mt-0.5">前序节点已完成但后续未启动，需要提前提醒下游同事</p>
            </div>
            <div className="divide-y divide-gray-100">
              {collabRisks.slice(0, 10).map((r, i) => (
                <div key={i} className="px-5 py-3 hover:bg-amber-50/30">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <Link href={`/orders/${r.orderId}`} className="font-semibold text-amber-700 hover:underline text-sm">
                          {r.orderNo}
                        </Link>
                        <span className="text-gray-500 text-sm">{r.customerName}</span>
                        <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">已停{r.daysSince}天</span>
                      </div>
                      <div className="text-xs text-gray-600 mt-1">
                        ✅ <span className="text-green-700">{r.from}</span> 已完成 →
                        ⏳ <span className="text-amber-700">{r.to}</span> 未启动
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        请提醒：<span className="font-medium">{r.toOwner}</span>
                      </div>
                    </div>
                    <Link
                      href={`/orders/${r.orderId}?tab=progress&from=/ceo`}
                      className="text-xs px-3 py-1.5 rounded bg-amber-600 text-white hover:bg-amber-700"
                    >
                      催办
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* 风险订单列表已移至独立页面 /risk-orders/[type]，点击顶部数字卡片进入 */}
      {/* 部门超期/堵点已移至数据分析页 /analytics */}
    </div>
  );
}
