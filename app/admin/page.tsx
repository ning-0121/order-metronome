import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { formatDate, isOverdue } from '@/lib/utils/date';
import { computeOrderStatus } from '@/lib/utils/order-status';
import Link from 'next/link';
import { BackfillButton } from '@/components/BackfillButton';
import { TodayMustHandle } from '@/components/TodayMustHandle';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import { getRoleLabel } from '@/lib/utils/i18n';

export default async function AdminPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  // Check if user is admin (using V1 role system)
  const { isAdmin } = await getCurrentUserRole(supabase);
  
  if (!isAdmin) {
    redirect('/dashboard');
  }

  // Get all orders with milestones
  const { data: orders } = await supabase.from('orders').select('*').order('created_at', { ascending: false });
  
  // Get all milestones for each order
  const ordersWithMilestones = [];
  if (orders) {
    for (const orderItem of orders) {
      const orderData = orderItem as any;
      const { data: milestones } = await supabase
        .from('milestones')
        .select('*')
        .eq('order_id', orderData.id);
      orderData.milestones = milestones || [];
      ordersWithMilestones.push(orderData);
    }
  }
  
  // Get all milestones for analysis
  const { data: allMilestones } = await supabase
    .from('milestones')
    .select('*')
    .order('due_at', { ascending: true });

  // Filter overdue milestones (V1: check by due_at date, but no overdue status) - 兼容中文状态
  const overdueMilestones = allMilestones?.filter((m: any) => 
    m.status !== '已完成' && m.due_at && isOverdue(m.due_at)
  ) || [];

  // Filter blocked milestones (兼容中文状态)
  const blockedMilestones = allMilestones?.filter((m: any) => 
    m.status === '卡住'
  ) || [];

  // Calculate bottlenecks by role
  const bottlenecksByRole: Record<string, number> = {};
  allMilestones?.forEach((m: any) => {
    if (m.status === '卡住' || (m.due_at && isOverdue(m.due_at))) {
      bottlenecksByRole[m.owner_role] = (bottlenecksByRole[m.owner_role] || 0) + 1;
    }
  });

  // Get risk orders (orders with overdue or blocked milestones)
  const riskOrderIds = new Set([
    ...overdueMilestones.map((m: any) => m.order_id),
    ...blockedMilestones.map((m: any) => m.order_id),
  ]);

  const riskOrders = ordersWithMilestones?.filter((o: any) => {
    const status = computeOrderStatus(o.milestones || []);
    return status.color === 'RED' || riskOrderIds.has(o.id);
  }) || [];

  // Get "Today Must Handle" milestones
  // Conditions:
  // 1. status = '卡住' (blocked)
  // 2. OR (status = '进行中' AND due_at <= now() + 24 hours)
  // 3. OR (status != '已完成' AND due_at < now()) (overdue)
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  
  // Get all milestones with orders
  const { data: allMilestonesWithOrders } = await (supabase
    .from('milestones') as any)
    .select(`
      id,
      order_id,
      name,
      owner_role,
      owner_user_id,
      due_at,
      status,
      orders!inner(
        id,
        order_no,
        customer_name
      )
    `)
    .order('due_at', { ascending: true });
  
  // Filter milestones based on conditions
  const todayMustHandleMilestones = (allMilestonesWithOrders || []).filter((m: any) => {
    // Condition 1: Blocked
    if (m.status === '卡住') {
      return true;
    }
    
    // Condition 2: In progress and due within 24 hours
    if (m.status === '进行中' && m.due_at) {
      const dueDate = new Date(m.due_at);
      if (dueDate <= tomorrow) {
        return true;
      }
    }
    
    // Condition 3: Overdue (not completed and due_at < now)
    if (m.status !== '已完成' && m.due_at) {
      const dueDate = new Date(m.due_at);
      if (dueDate < now) {
        return true;
      }
    }
    
    return false;
  });

  // Get owner user info for milestones
  const milestoneIds = (todayMustHandleMilestones || []).map((m: any) => m.id);
  const ownerUserIds = (todayMustHandleMilestones || [])
    .map((m: any) => m.owner_user_id)
    .filter((id: string | null) => id !== null) as string[];
  
  let userMap: Record<string, any> = {};
  if (ownerUserIds.length > 0) {
    const { data: profiles } = await (supabase
      .from('profiles') as any)
      .select('user_id, email, full_name, role')
      .in('user_id', ownerUserIds);
    
    if (profiles) {
      userMap = profiles.reduce((acc: Record<string, any>, profile: any) => {
        acc[profile.user_id] = profile;
        return acc;
      }, {});
    }
  }

  // Get pending delay requests for these milestones
  let delayRequestMap: Record<string, boolean> = {};
  if (milestoneIds.length > 0) {
    const { data: delayRequests } = await (supabase
      .from('delay_requests') as any)
      .select('milestone_id')
      .in('milestone_id', milestoneIds)
      .eq('status', 'pending');
    
    if (delayRequests) {
      delayRequestMap = delayRequests.reduce((acc: Record<string, boolean>, dr: any) => {
        acc[dr.milestone_id] = true;
        return acc;
      }, {});
    }
  }

  // Format milestones with user info and delay request status
  const formattedTodayMilestones = (todayMustHandleMilestones || []).map((m: any) => ({
    id: m.id,
    order_id: m.order_id,
    name: m.name,
    owner_role: m.owner_role,
    owner_user_id: m.owner_user_id,
    owner_user: m.owner_user_id ? userMap[m.owner_user_id] || null : null,
    due_at: m.due_at,
    status: m.status,
    order_no: m.orders?.order_no || '',
    customer_name: m.orders?.customer_name || '',
    has_pending_delay: delayRequestMap[m.id] || false,
  }));

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 text-white">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">管理后台</h1>
            <p className="text-sm text-gray-500">全局概览与风险分析</p>
          </div>
        </div>
      </div>

      {/* Today Must Handle Section */}
      <TodayMustHandle milestones={formattedTodayMilestones} />

      <div className="mb-6">
        <BackfillButton />
      </div>

      {/* Stats Overview */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <div className="stat-card">
          <div className="flex items-center gap-3 mb-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-orange-100">
              <svg className="w-4 h-4 text-orange-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <span className="text-sm font-medium text-gray-500">风险订单</span>
          </div>
          <div className="stat-value text-orange-600">{riskOrders.length}</div>
        </div>
        <div className="stat-card">
          <div className="flex items-center gap-3 mb-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-red-100">
              <svg className="w-4 h-4 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <span className="text-sm font-medium text-gray-500">已超期节点</span>
          </div>
          <div className="stat-value text-red-600">{overdueMilestones.length}</div>
        </div>
        <div className="stat-card">
          <div className="flex items-center gap-3 mb-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-yellow-100">
              <svg className="w-4 h-4 text-yellow-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
              </svg>
            </div>
            <span className="text-sm font-medium text-gray-500">已阻塞节点</span>
          </div>
          <div className="stat-value text-yellow-600">{blockedMilestones.length}</div>
        </div>
      </div>

      {/* Risk Orders & Overdue Milestones */}
      <div className="grid gap-6 md:grid-cols-2 mb-8">
        {/* Risk Orders */}
        <div className="section">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-orange-100">
              <span className="text-orange-600">⚠️</span>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900">风险订单</h2>
              <p className="text-sm text-gray-500">{riskOrders.length} 个订单需要关注</p>
            </div>
          </div>
          {riskOrders.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              <div className="text-3xl mb-2">✓</div>
              <p>暂无风险订单</p>
            </div>
          ) : (
            <div className="space-y-3 max-h-80 overflow-y-auto">
              {riskOrders.slice(0, 5).map((order: any) => (
                <Link
                  key={order.id}
                  href={`/orders/${order.id}`}
                  className="block p-4 rounded-xl border border-orange-200 hover:border-orange-300 bg-orange-50/50 transition-all hover:shadow-sm"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="font-medium text-gray-900">{order.order_no}</span>
                      <p className="text-sm text-gray-600 mt-1">{order.customer_name}</p>
                    </div>
                    <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </div>
                </Link>
              ))}
              {riskOrders.length > 5 && (
                <p className="text-center text-sm text-indigo-600 font-medium py-2">
                  还有 {riskOrders.length - 5} 个风险订单...
                </p>
              )}
            </div>
          )}
        </div>

        {/* Overdue Milestones */}
        <div className="section">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-red-100">
              <span className="text-red-600">🕐</span>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900">超期节点</h2>
              <p className="text-sm text-gray-500">{overdueMilestones.length} 个节点已超期</p>
            </div>
          </div>
          {overdueMilestones.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              <div className="text-3xl mb-2">✓</div>
              <p>暂无超期节点</p>
            </div>
          ) : (
            <div className="space-y-3 max-h-80 overflow-y-auto">
              {overdueMilestones.slice(0, 5).map((milestone: any) => (
                <Link
                  key={milestone.id}
                  href={`/orders/${milestone.order_id}#milestone-${milestone.id}`}
                  className="block p-4 rounded-xl border border-red-200 hover:border-red-300 bg-red-50/50 transition-all hover:shadow-sm"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium text-gray-900 truncate">{(milestone.orders as any)?.order_no}</span>
                        <span className="badge badge-danger">超期</span>
                      </div>
                      <p className="text-sm text-gray-700 mb-1">{milestone.name}</p>
                      <div className="flex items-center gap-4 text-xs text-gray-500">
                        <span>截止: {formatDate(milestone.due_at)}</span>
                        <span>负责: {getRoleLabel(milestone.owner_role)}</span>
                      </div>
                    </div>
                    <svg className="w-5 h-5 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </div>
                </Link>
              ))}
              {overdueMilestones.length > 5 && (
                <p className="text-center text-sm text-indigo-600 font-medium py-2">
                  还有 {overdueMilestones.length - 5} 个超期节点...
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Bottleneck Analysis */}
      <div className="section">
        <div className="flex items-center gap-3 mb-4">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-purple-100">
            <span className="text-purple-600">📊</span>
          </div>
          <div>
            <h2 className="text-lg font-semibold text-gray-900">角色瓶颈分析</h2>
            <p className="text-sm text-gray-500">识别需要关注的责任角色</p>
          </div>
        </div>
        {Object.keys(bottlenecksByRole).length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            <div className="text-3xl mb-2">✓</div>
            <p>暂无瓶颈</p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-gray-200">
            <table className="table-modern">
              <thead>
                <tr>
                  <th>责任角色</th>
                  <th>超期/阻塞数量</th>
                  <th>占比</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(bottlenecksByRole)
                  .sort((a, b) => b[1] - a[1])
                  .map(([role, count]) => {
                    const total = Object.values(bottlenecksByRole).reduce((sum, c) => sum + c, 0);
                    const percentage = total > 0 ? Math.round((count / total) * 100) : 0;
                    return (
                      <tr key={role}>
                        <td>
                          <span className="font-medium text-gray-900">{getRoleLabel(role)}</span>
                        </td>
                        <td>
                          <span className="badge badge-danger">{count}</span>
                        </td>
                        <td>
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden max-w-24">
                              <div
                                className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 rounded-full"
                                style={{ width: `${percentage}%` }}
                              />
                            </div>
                            <span className="text-sm text-gray-500">{percentage}%</span>
                          </div>
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
  );
}
