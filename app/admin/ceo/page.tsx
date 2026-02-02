import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { formatDate, isOverdue } from '@/lib/utils/date';
import Link from 'next/link';
import { DelayRequestActions } from '@/components/DelayRequestActions';
import { getCurrentUserRole } from '@/lib/utils/user-role';

export default async function CEODashboardPage() {
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

  // 1. Overdue milestones (in_progress and now > due_at)
  const { data: allMilestones } = await supabase
    .from('milestones')
    .select(`
      *,
      orders!inner (
        id,
        order_no,
        customer_name
      )
    `)
    .order('due_at', { ascending: true });

  const overdueMilestones = (allMilestones || []).filter((m: any) => {
    return m.status === '进行中' && m.due_at && isOverdue(m.due_at);
  });

  // 2. Blocked milestones
  const blockedMilestones = (allMilestones || []).filter((m: any) => {
    return m.status === '卡住';
  });

  // 3. Pending delay requests with full details
  const { data: pendingDelayRequests } = await (supabase
    .from('delay_requests') as any)
    .select(`
      *,
      milestones!inner (
        id,
        name,
        step_key,
        order_id,
        orders!inner (
          id,
          order_no,
          customer_name
        )
      )
    `)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  // 4. Bottleneck summary by owner_role
  const bottlenecksByRole: Record<string, number> = {};
  (allMilestones || []).forEach((m: any) => {
    if (m.status === '卡住' || (m.status === '进行中' && m.due_at && isOverdue(m.due_at))) {
      const role = m.owner_role || 'unknown';
      bottlenecksByRole[role] = (bottlenecksByRole[role] || 0) + 1;
    }
  });

  // 5. Bottleneck summary by owner_user_id
  const bottlenecksByUser: Record<string, { count: number; user_id: string; milestones: any[] }> = {};
  (allMilestones || []).forEach((m: any) => {
    if (m.status === '卡住' || (m.status === '进行中' && m.due_at && isOverdue(m.due_at))) {
      const userId = m.owner_user_id || 'unassigned';
      if (!bottlenecksByUser[userId]) {
        bottlenecksByUser[userId] = {
          count: 0,
          user_id: userId,
          milestones: [],
        };
      }
      bottlenecksByUser[userId].count += 1;
      bottlenecksByUser[userId].milestones.push(m);
    }
  });

  // Get user profiles for owner_user_id display
  const userIds = Object.keys(bottlenecksByUser).filter(id => id !== 'unassigned');
  const { data: userProfiles } = userIds.length > 0
    ? await supabase
        .from('profiles')
        .select('user_id, full_name, email')
        .in('user_id', userIds)
    : { data: [] };

  const userProfileMap = new Map(
    (userProfiles || []).map((p: any) => [p.user_id, p])
  );

  return (
    <div className="space-y-6 bg-white min-h-screen p-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">CEO 管理面板</h1>
        <p className="text-gray-600 mt-2">全局概览与控制中心</p>
      </div>

      {/* Summary Cards */}
      <div className="grid gap-6 md:grid-cols-4">
        <div className="rounded-lg border border-gray-200 bg-white p-6 text-gray-900">
          <h3 className="text-lg font-semibold mb-2 text-gray-700">已超期（进行中）</h3>
          <p className="text-3xl font-bold text-red-600">{overdueMilestones.length}</p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-6 text-gray-900">
          <h3 className="text-lg font-semibold mb-2 text-gray-700">已阻塞</h3>
          <p className="text-3xl font-bold text-orange-600">{blockedMilestones.length}</p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-6 text-gray-900">
          <h3 className="text-lg font-semibold mb-2 text-gray-700">待审批延期</h3>
          <p className="text-3xl font-bold text-yellow-600">{pendingDelayRequests?.length || 0}</p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-6 text-gray-900">
          <h3 className="text-lg font-semibold mb-2 text-gray-700">总瓶颈数</h3>
          <p className="text-3xl font-bold text-purple-600">
            {Object.values(bottlenecksByRole).reduce((sum, count) => sum + count, 0)}
          </p>
        </div>
      </div>

      {/* Overdue Milestones */}
      <div>
        <h2 className="text-2xl font-semibold mb-4 text-gray-900">超期节点（进行中）</h2>
        {overdueMilestones.length === 0 ? (
          <p className="text-gray-500 bg-gray-50 p-4 rounded">暂无超期节点</p>
        ) : (
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {overdueMilestones.map((milestone: any) => (
              <Link
                key={milestone.id}
                href={`/orders/${milestone.order_id}#milestone-${milestone.id}`}
                className="block rounded-lg border border-red-200 bg-red-50 p-4 hover:bg-red-100 text-gray-900"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="font-semibold text-gray-900">{milestone.name}</div>
                    <div className="text-sm text-gray-700 mt-1">
                      订单: {milestone.orders?.order_no} | 客户: {milestone.orders?.customer_name}
                    </div>
                    <div className="text-sm text-gray-600 mt-1">
                      到期: {formatDate(milestone.due_at)} | 负责人: {milestone.owner_role}
                    </div>
                  </div>
                  <div className="ml-4 text-red-700 font-semibold">超期</div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Blocked Milestones */}
      <div>
        <h2 className="text-2xl font-semibold mb-4 text-gray-900">阻塞节点</h2>
        {blockedMilestones.length === 0 ? (
          <p className="text-gray-500 bg-gray-50 p-4 rounded">暂无阻塞节点</p>
        ) : (
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {blockedMilestones.map((milestone: any) => (
              <Link
                key={milestone.id}
                href={`/orders/${milestone.order_id}#milestone-${milestone.id}`}
                className="block rounded-lg border border-orange-200 bg-orange-50 p-4 hover:bg-orange-100 text-gray-900"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="font-semibold text-gray-900">{milestone.name}</div>
                    <div className="text-sm text-gray-700 mt-1">
                      订单: {milestone.orders?.order_no} | 客户: {milestone.orders?.customer_name}
                    </div>
                    <div className="text-sm text-gray-600 mt-1">
                      负责人: {milestone.owner_role}
                      {milestone.notes && (
                        <span className="ml-2 text-orange-700">原因: {milestone.notes.substring(0, 100)}</span>
                      )}
                    </div>
                  </div>
                  <div className="ml-4 text-orange-700 font-semibold">阻塞</div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Pending Delay Requests */}
      <div>
        <h2 className="text-2xl font-semibold mb-4 text-gray-900">待审批延期申请</h2>
        {!pendingDelayRequests || pendingDelayRequests.length === 0 ? (
          <p className="text-gray-500 bg-gray-50 p-4 rounded">暂无待审批延期申请</p>
        ) : (
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {pendingDelayRequests.map((request: any) => (
              <div
                key={request.id}
                className="block rounded-lg border border-yellow-200 bg-yellow-50 p-4 text-gray-900"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="font-semibold text-gray-900">
                      {request.milestones?.name || '未知节点'}
                    </div>
                    <div className="text-sm text-gray-700 mt-1">
                      订单: <Link href={`/orders/${request.milestones?.order_id}`} className="text-blue-600 hover:text-blue-700">{request.milestones?.orders?.order_no}</Link> |
                      客户: {request.milestones?.orders?.customer_name}
                    </div>
                    <div className="text-sm text-gray-600 mt-1">
                      <strong>原因类型:</strong> {request.reason_type}
                    </div>
                    {request.reason_detail && (
                      <div className="text-sm text-gray-600 mt-1">
                        <strong>详细原因:</strong> {request.reason_detail}
                      </div>
                    )}
                    {request.proposed_new_anchor_date && (
                      <div className="text-sm text-gray-600 mt-1">
                        <strong>新锚点日期:</strong> {formatDate(request.proposed_new_anchor_date)}
                      </div>
                    )}
                    {request.proposed_new_due_at && (
                      <div className="text-sm text-gray-600 mt-1">
                        <strong>新到期日期:</strong> {formatDate(request.proposed_new_due_at)}
                      </div>
                    )}
                    {request.requires_customer_approval && (
                      <div className="text-sm mt-2">
                        <strong className="text-orange-700">需要客户确认:</strong> 是
                        {request.customer_approval_evidence_url ? (
                          <span className="ml-2 text-green-700">✓ 已提供证据</span>
                        ) : (
                          <span className="ml-2 text-red-700">⚠ 未提供证据</span>
                        )}
                      </div>
                    )}
                    {request.customer_approval_evidence_url && (
                      <div className="text-sm text-gray-600 mt-1">
                        <a
                          href={request.customer_approval_evidence_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:text-blue-700"
                        >
                          查看客户确认证据
                        </a>
                      </div>
                    )}
                    <div className="text-xs text-gray-500 mt-2">
                      创建时间: {formatDate(request.created_at)}
                    </div>
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

      {/* Bottleneck Summary by Role */}
      <div>
        <h2 className="text-2xl font-semibold mb-4 text-gray-900">角色瓶颈分析</h2>
        {Object.keys(bottlenecksByRole).length === 0 ? (
          <p className="text-gray-500 bg-gray-50 p-4 rounded">暂无瓶颈</p>
        ) : (
          <div className="rounded-lg border border-gray-200 bg-white p-6">
            <table className="w-full text-gray-900">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 font-semibold">责任角色</th>
                  <th className="text-left py-2 font-semibold">超期/阻塞数量</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(bottlenecksByRole)
                  .sort((a, b) => b[1] - a[1])
                  .map(([role, count]) => (
                    <tr key={role} className="border-b">
                      <td className="py-2 font-medium">{role}</td>
                      <td className="py-2">{count}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Bottleneck Summary by User */}
      <div>
        <h2 className="text-2xl font-semibold mb-4 text-gray-900">用户瓶颈分析</h2>
        {Object.keys(bottlenecksByUser).length === 0 ? (
          <p className="text-gray-500 bg-gray-50 p-4 rounded">暂无瓶颈</p>
        ) : (
          <div className="rounded-lg border border-gray-200 bg-white p-6">
            <table className="w-full text-gray-900">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 font-semibold">用户</th>
                  <th className="text-left py-2 font-semibold">超期/阻塞数量</th>
                  <th className="text-left py-2 font-semibold">操作</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(bottlenecksByUser)
                  .sort((a, b) => b[1].count - a[1].count)
                  .map(([userId, data]) => {
                    const profile = userProfileMap.get(userId);
                    const displayName = profile
                      ? profile.full_name || profile.email || userId
                      : userId === 'unassigned'
                      ? '未分配'
                      : userId;

                    return (
                      <tr key={userId} className="border-b">
                        <td className="py-2 font-medium">{displayName}</td>
                        <td className="py-2">{data.count}</td>
                        <td className="py-2">
                          <Link
                            href={`/orders/${data.milestones[0]?.order_id || '#'}`}
                            className="text-blue-600 hover:text-blue-700 text-sm"
                          >
                            查看订单
                          </Link>
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
