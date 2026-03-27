import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { formatDate, isOverdue } from '@/lib/utils/date';
import { computeOrderStatus } from '@/lib/utils/order-status';
import Link from 'next/link';
import { DelayRequestActions } from '@/components/DelayRequestActions';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import { getRoleLabel } from '@/lib/utils/i18n';

// 状态兼容函数
const _isDone = (s: string) => s === 'done' || s === '已完成' || s === 'completed';
const _isActive = (s: string) => s === 'in_progress' || s === '进行中';
const _isBlocked = (s: string) => s === 'blocked' || s === '卡单' || s === '卡住';

export default async function CEOWarRoom() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) redirect('/dashboard');

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

  // 风险分类
  const riskRed = ordersWithMilestones.filter(o => computeOrderStatus(o.milestones || []).color === 'RED');
  const riskYellow = ordersWithMilestones.filter(o => computeOrderStatus(o.milestones || []).color === 'YELLOW');
  const riskGreen = ordersWithMilestones.filter(o => computeOrderStatus(o.milestones || []).color === 'GREEN');

  // 所有超期/卡住里程碑
  const { data: allMilestonesWithOrders } = await (supabase.from('milestones') as any)
    .select(`id, order_id, name, step_key, owner_role, owner_user_id, due_at, status, orders!inner(id, order_no, customer_name)`)
    .order('due_at', { ascending: true });

  const overdueMilestones = (allMilestonesWithOrders || []).filter((m: any) =>
    !_isDone(m.status) && m.due_at && isOverdue(m.due_at)
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
    customerName: string;
    description: string;
    owner: string;
    ownerRole: string;
    daysInfo: string;
  }

  const topItems: TopItem[] = [];

  // 超期节点（优先级最高）
  overdueMilestones.slice(0, 20).forEach((m: any) => {
    const dueAt = new Date(m.due_at);
    const daysOver = Math.max(1, Math.ceil((now.getTime() - dueAt.getTime()) / (86400000)));
    const ownerProfile = m.owner_user_id ? userMap[m.owner_user_id] : null;
    topItems.push({
      id: `overdue-${m.id}`,
      priority: daysOver * 10 + (m.is_critical ? 5 : 0),
      type: 'overdue',
      typeLabel: '超期',
      orderId: m.order_id,
      orderNo: m.orders?.order_no || '',
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
    topItems.push({
      id: `blocked-${m.id}`,
      priority: 50,
      type: 'blocked',
      typeLabel: '卡住',
      orderId: m.order_id,
      orderNo: m.orders?.order_no || '',
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

  // 按优先级排序，取 Top 5
  topItems.sort((a, b) => b.priority - a.priority);
  const top5 = topItems.slice(0, 5);

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
  // 找出风险最高的订单
  const worstOrder = riskRed.sort((a: any, b: any) => {
    const aOverdue = (a.milestones || []).filter((m: any) => !_isDone(m.status) && m.due_at && isOverdue(m.due_at)).length;
    const bOverdue = (b.milestones || []).filter((m: any) => !_isDone(m.status) && m.due_at && isOverdue(m.due_at)).length;
    return bOverdue - aOverdue;
  })[0];

  const aiInsights: string[] = [];
  if (worstDept) {
    aiInsights.push(`📌 ${getRoleLabel(worstDept[0])}部门当前问题最多（${worstDept[1].count} 个超期节点），建议重点关注。`);
  }
  if (worstOrder) {
    const overdueInOrder = (worstOrder.milestones || []).filter((m: any) => !_isDone(m.status) && m.due_at && isOverdue(m.due_at)).length;
    aiInsights.push(`🚨 订单 ${worstOrder.order_no}（${worstOrder.customer_name}）风险最高，有 ${overdueInOrder} 个超期节点，需要 CEO 介入。`);
  }
  if ((pendingDelays || []).length > 2) {
    aiInsights.push(`⏳ 当前有 ${(pendingDelays || []).length} 个延期申请待审批，建议今日内全部处理。`);
  }
  if (blockedMilestones.length > 0) {
    aiInsights.push(`🔒 ${blockedMilestones.length} 个节点被阻塞，影响后续流程推进。`);
  }
  if (riskRed.length === 0 && overdueMilestones.length <= 2) {
    aiInsights.push(`✅ 整体运行良好，无需紧急决策。`);
  }
  if ((tomorrowRisk || []).length > 0) {
    aiInsights.push(`⚡ 未来48小时有 ${(tomorrowRisk || []).length} 个节点即将到期，建议提前跟进。`);
  }

  // ===== 订单流动状态 =====
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
    return (o.milestones || []).some((m: any) => !_isDone(m.status) && m.due_at && isOverdue(m.due_at));
  });

  // ===== 页面渲染 =====
  const TYPE_COLORS: Record<string, string> = {
    overdue: 'bg-red-100 text-red-800 border-red-200',
    blocked: 'bg-orange-100 text-orange-800 border-orange-200',
    delay: 'bg-yellow-100 text-yellow-800 border-yellow-200',
    risk_soon: 'bg-purple-100 text-purple-800 border-purple-200',
  };

  return (
    <div className="min-h-screen bg-gray-50 p-4 md:p-6 space-y-6">
      {/* ===== 头部 ===== */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold text-gray-900">⚔️ 作战指挥中心</h1>
          <p className="text-gray-500 text-sm mt-1">
            {totalOrders} 个订单 · {overdueMilestones.length} 个超期 · {blockedMilestones.length} 个阻塞 · {(pendingDelays || []).length} 个待审批
          </p>
        </div>
        <div className="text-right text-sm text-gray-500">
          {now.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}
        </div>
      </div>

      {/* ===== 状态概览卡片 ===== */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="bg-white rounded-xl border border-gray-200 p-4 text-center">
          <div className="text-3xl font-bold text-red-600">{riskRed.length}</div>
          <div className="text-xs text-gray-500 mt-1">🔴 红色风险</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4 text-center">
          <div className="text-3xl font-bold text-yellow-600">{riskYellow.length}</div>
          <div className="text-xs text-gray-500 mt-1">🟡 黄色关注</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4 text-center">
          <div className="text-3xl font-bold text-green-600">{riskGreen.length}</div>
          <div className="text-xs text-gray-500 mt-1">🟢 绿色正常</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4 text-center">
          <div className="text-3xl font-bold text-orange-600">{blockedMilestones.length}</div>
          <div className="text-xs text-gray-500 mt-1">🔒 阻塞中</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4 text-center">
          <div className="text-3xl font-bold text-indigo-600">{completionRate}%</div>
          <div className="text-xs text-gray-500 mt-1">📊 完成率</div>
        </div>
      </div>

      {/* ===== 1. 今日 Top 5 必须处理 ===== */}
      <div className="bg-white rounded-xl border-2 border-red-100 shadow-sm overflow-hidden">
        <div className="bg-red-50 px-5 py-3 border-b border-red-100">
          <h2 className="text-lg font-bold text-red-900">🎯 今日必须处理（Top 5）</h2>
          <p className="text-xs text-red-700">按紧急程度排序，点击直接进入处理</p>
        </div>
        {top5.length === 0 ? (
          <div className="p-8 text-center">
            <div className="text-4xl mb-2">🎉</div>
            <div className="text-gray-600">今日暂无紧急事项，继续保持！</div>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {top5.map((item, i) => (
              <div key={item.id} className="px-5 py-4 hover:bg-gray-50 transition-colors">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <span className="text-lg font-bold text-gray-400 w-6 text-center flex-shrink-0">
                      {i + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${TYPE_COLORS[item.type] || ''}`}>
                          {item.typeLabel}
                        </span>
                        <Link href={`/orders/${item.orderId}`} className="font-semibold text-blue-700 hover:underline text-sm">
                          {item.orderNo}
                        </Link>
                        <span className="text-gray-500 text-sm truncate">{item.customerName}</span>
                      </div>
                      <div className="text-sm text-gray-700 mt-1">{item.description}</div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        负责：{item.owner}（{item.ownerRole}）· {item.daysInfo}
                      </div>
                    </div>
                  </div>
                  <Link
                    href={item.type === 'delay' ? `/ceo#delay-approvals` : `/orders/${item.orderId}?tab=progress`}
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

      {/* ===== 2. AI 分析建议 ===== */}
      <div className="bg-white rounded-xl border border-indigo-200 shadow-sm overflow-hidden">
        <div className="bg-indigo-50 px-5 py-3 border-b border-indigo-100">
          <h2 className="text-lg font-bold text-indigo-900">🤖 AI 分析建议</h2>
        </div>
        <div className="p-5 space-y-2">
          {aiInsights.map((insight, i) => (
            <div key={i} className="text-sm text-gray-800 leading-relaxed">{insight}</div>
          ))}
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        {/* ===== 3. 风险订单区 ===== */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="bg-gray-50 px-5 py-3 border-b border-gray-200">
            <h2 className="text-lg font-bold text-gray-900">🔥 风险订单</h2>
          </div>
          <div className="p-4 space-y-3">
            {/* 红色 */}
            <details open={riskRed.length > 0}>
              <summary className="cursor-pointer flex items-center justify-between py-2 px-3 bg-red-50 rounded-lg">
                <span className="font-semibold text-red-800">🔴 红色风险</span>
                <span className="text-sm font-bold text-red-700">{riskRed.length}</span>
              </summary>
              <div className="mt-2 space-y-1 pl-2">
                {riskRed.length === 0 ? (
                  <p className="text-sm text-gray-500 py-1">无</p>
                ) : riskRed.slice(0, 10).map((o: any) => (
                  <Link key={o.id} href={`/orders/${o.id}?tab=progress`} className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-gray-50 text-sm group">
                    <span>
                      <span className="font-medium text-gray-900">{o.order_no}</span>
                      <span className="text-gray-500 ml-2">{o.customer_name}</span>
                    </span>
                    <span className="text-blue-600 opacity-0 group-hover:opacity-100 text-xs">查看 →</span>
                  </Link>
                ))}
              </div>
            </details>
            {/* 黄色 */}
            <details>
              <summary className="cursor-pointer flex items-center justify-between py-2 px-3 bg-yellow-50 rounded-lg">
                <span className="font-semibold text-yellow-800">🟡 黄色关注</span>
                <span className="text-sm font-bold text-yellow-700">{riskYellow.length}</span>
              </summary>
              <div className="mt-2 space-y-1 pl-2">
                {riskYellow.length === 0 ? (
                  <p className="text-sm text-gray-500 py-1">无</p>
                ) : riskYellow.slice(0, 10).map((o: any) => (
                  <Link key={o.id} href={`/orders/${o.id}?tab=progress`} className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-gray-50 text-sm group">
                    <span>
                      <span className="font-medium text-gray-900">{o.order_no}</span>
                      <span className="text-gray-500 ml-2">{o.customer_name}</span>
                    </span>
                    <span className="text-blue-600 opacity-0 group-hover:opacity-100 text-xs">查看 →</span>
                  </Link>
                ))}
              </div>
            </details>
            {/* 绿色 */}
            <details>
              <summary className="cursor-pointer flex items-center justify-between py-2 px-3 bg-green-50 rounded-lg">
                <span className="font-semibold text-green-800">🟢 正常</span>
                <span className="text-sm font-bold text-green-700">{riskGreen.length}</span>
              </summary>
              <div className="mt-2 space-y-1 pl-2">
                {riskGreen.slice(0, 5).map((o: any) => (
                  <Link key={o.id} href={`/orders/${o.id}`} className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-gray-50 text-sm group">
                    <span>
                      <span className="font-medium text-gray-900">{o.order_no}</span>
                      <span className="text-gray-500 ml-2">{o.customer_name}</span>
                    </span>
                    <span className="text-blue-600 opacity-0 group-hover:opacity-100 text-xs">查看 →</span>
                  </Link>
                ))}
              </div>
            </details>
          </div>
        </div>

        {/* ===== 4. 延期/堵点中心 ===== */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="bg-gray-50 px-5 py-3 border-b border-gray-200">
            <h2 className="text-lg font-bold text-gray-900">🚧 超期/堵点（按部门）</h2>
          </div>
          <div className="p-4 space-y-3">
            {Object.entries(deptOverdue).length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-4">暂无超期节点 🎉</p>
            ) : (
              Object.entries(deptOverdue)
                .sort((a, b) => b[1].count - a[1].count)
                .map(([role, data]) => (
                  <details key={role}>
                    <summary className="cursor-pointer flex items-center justify-between py-2 px-3 bg-red-50/50 rounded-lg">
                      <span className="font-medium text-gray-900">{getRoleLabel(role)}</span>
                      <span className="text-sm font-bold text-red-600">{data.count} 个超期</span>
                    </summary>
                    <div className="mt-2 space-y-1 pl-2">
                      {data.items.slice(0, 8).map((m: any) => {
                        const dueAt = new Date(m.due_at);
                        const daysOver = Math.max(1, Math.ceil((now.getTime() - dueAt.getTime()) / 86400000));
                        const ownerProfile = m.owner_user_id ? userMap[m.owner_user_id] : null;
                        return (
                          <Link key={m.id} href={`/orders/${m.order_id}?tab=progress`}
                            className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-gray-50 text-sm group">
                            <span className="flex-1 min-w-0">
                              <span className="font-medium">{m.orders?.order_no}</span>
                              <span className="text-gray-500 mx-1">·</span>
                              <span className="text-gray-700">{m.name}</span>
                              <span className="text-gray-400 mx-1">·</span>
                              <span className="text-gray-500">{ownerProfile?.name || '未分配'}</span>
                            </span>
                            <span className="flex items-center gap-2 flex-shrink-0">
                              <span className="text-xs text-red-600">超{daysOver}天</span>
                              <span className="text-blue-600 opacity-0 group-hover:opacity-100 text-xs">→</span>
                            </span>
                          </Link>
                        );
                      })}
                    </div>
                  </details>
                ))
            )}
          </div>
        </div>
      </div>

      {/* ===== 5. 待审批延期 ===== */}
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

      {/* ===== 6. 订单流动状态 ===== */}
      <div className="grid md:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border border-blue-200 p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-bold text-blue-900">🔄 进行中</h3>
            <span className="text-2xl font-bold text-blue-600">{inProgress.length}</span>
          </div>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {inProgress.slice(0, 8).map((o: any) => (
              <Link key={o.id} href={`/orders/${o.id}`} className="block text-sm text-gray-700 hover:text-blue-600 truncate">
                {o.order_no} — {o.customer_name}
              </Link>
            ))}
          </div>
        </div>
        <div className="bg-white rounded-xl border border-green-200 p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-bold text-green-900">📦 待出货</h3>
            <span className="text-2xl font-bold text-green-600">{readyToShip.length}</span>
          </div>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {readyToShip.slice(0, 8).map((o: any) => (
              <Link key={o.id} href={`/orders/${o.id}`} className="block text-sm text-gray-700 hover:text-green-600 truncate">
                {o.order_no} — {o.customer_name}
              </Link>
            ))}
            {readyToShip.length === 0 && <p className="text-sm text-gray-400">暂无</p>}
          </div>
        </div>
        <div className="bg-white rounded-xl border border-red-200 p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-bold text-red-900">⚠️ 已延期</h3>
            <span className="text-2xl font-bold text-red-600">{delayed.length}</span>
          </div>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {delayed.slice(0, 8).map((o: any) => (
              <Link key={o.id} href={`/orders/${o.id}?tab=progress`} className="block text-sm text-gray-700 hover:text-red-600 truncate">
                {o.order_no} — {o.customer_name}
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* ===== 7. 明日提醒 ===== */}
      {(tomorrowRisk || []).length > 0 && (
        <div className="bg-white rounded-xl border border-purple-200 shadow-sm overflow-hidden">
          <div className="bg-purple-50 px-5 py-3 border-b border-purple-100">
            <h2 className="text-lg font-bold text-purple-900">⚡ 明日风险窗口（{(tomorrowRisk || []).length} 个节点即将到期）</h2>
          </div>
          <div className="p-4 space-y-1">
            {(tomorrowRisk as any[]).slice(0, 10).map((m: any) => (
              <Link key={m.id} href={`/orders/${m.order_id}?tab=progress`}
                className="flex items-center justify-between py-2 px-3 rounded hover:bg-gray-50 text-sm group">
                <span>
                  <span className="font-medium">{m.orders?.order_no}</span>
                  <span className="text-gray-500 mx-2">·</span>
                  <span className="text-gray-700">{m.name}</span>
                  <span className="text-gray-400 mx-1">·</span>
                  <span className="text-xs text-gray-500">{getRoleLabel(m.owner_role)}</span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="text-xs text-purple-600">到期：{formatDate(m.due_at)}</span>
                  <span className="text-blue-600 opacity-0 group-hover:opacity-100 text-xs">→</span>
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
