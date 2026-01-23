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
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">管理后台</h1>
        <p className="text-gray-600 mt-2">全局概览与风险分析</p>
      </div>

      {/* Today Must Handle Section */}
      <TodayMustHandle milestones={formattedTodayMilestones} />

      <BackfillButton />

      <div className="grid gap-6 md:grid-cols-3">
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <h3 className="text-lg font-semibold mb-2">风险订单</h3>
          <p className="text-3xl font-bold text-orange-600">{riskOrders.length}</p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <h3 className="text-lg font-semibold mb-2">已超期节点</h3>
          <p className="text-3xl font-bold text-red-600">{overdueMilestones.length}</p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <h3 className="text-lg font-semibold mb-2">已阻塞节点</h3>
          <p className="text-3xl font-bold text-orange-600">{blockedMilestones.length}</p>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <h2 className="text-2xl font-semibold mb-4">风险订单列表</h2>
          {riskOrders.length === 0 ? (
            <p className="text-gray-500">暂无风险订单</p>
          ) : (
            <div className="space-y-2">
              {riskOrders.map((order: any) => (
                <Link
                  key={order.id}
                  href={`/orders/${order.id}`}
                  className="block rounded-lg border border-orange-200 bg-orange-50 p-4 hover:bg-orange-100"
                >
                  <div className="font-semibold">{order.order_no}</div>
                  <div className="text-sm text-gray-600">{order.customer_name}</div>
                </Link>
              ))}
            </div>
          )}
        </div>

        <div>
          <h2 className="text-2xl font-semibold mb-4">超期节点列表</h2>
          {overdueMilestones.length === 0 ? (
            <p className="text-gray-500">暂无超期节点</p>
          ) : (
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {overdueMilestones.map((milestone: any) => (
                <Link
                  key={milestone.id}
                  href={`/orders/${milestone.order_id}#milestone-${milestone.id}`}
                  className="block rounded-lg border border-red-200 bg-red-50 p-4 hover:bg-red-100"
                >
                  <div className="font-semibold">{milestone.name}</div>
                  <div className="text-sm text-gray-600">
                    订单: {(milestone.orders as any)?.order_no} | 应完成日期: {formatDate(milestone.due_at)}
                  </div>
                  <div className="text-sm text-gray-500">责任角色: {getRoleLabel(milestone.owner_role)}</div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      <div>
        <h2 className="text-2xl font-semibold mb-4">角色瓶颈分析</h2>
        {Object.keys(bottlenecksByRole).length === 0 ? (
          <p className="text-gray-500">暂无瓶颈</p>
        ) : (
          <div className="rounded-lg border border-gray-200 bg-white p-6">
            <table className="w-full">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2">责任角色</th>
                  <th className="text-left py-2">超期/阻塞数量</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(bottlenecksByRole)
                  .sort((a, b) => b[1] - a[1])
                  .map(([role, count]) => (
                    <tr key={role} className="border-b">
                      <td className="py-2 font-medium">{getRoleLabel(role)}</td>
                      <td className="py-2">{count}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
