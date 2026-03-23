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
        .select('user_id, name, email')
        .in('user_id', userIds)
    : { data: [] };

  const userProfileMap = new Map(
    (userProfiles || []).map((p: any) => [p.user_id, { ...p, full_name: p.name ?? p.email }])
  );

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 text-white">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
            </svg>
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">CEO 控制台</h1>
            <p className="text-sm text-gray-500">全局概览与审批中心</p>
          </div>
        </div>
      </div>

      {/* Stats Overview */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <div className="stat-card">
          <div className="flex items-center gap-2 mb-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-red-100">
              <svg className="w-4 h-4 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <span className="text-xs font-medium text-gray-500">已超期</span>
          </div>
          <div className="stat-value text-red-600">{overdueMilestones.length}</div>
        </div>
        <div className="stat-card">
          <div className="flex items-center gap-2 mb-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-orange-100">
              <svg className="w-4 h-4 text-orange-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
              </svg>
            </div>
            <span className="text-xs font-medium text-gray-500">已阻塞</span>
          </div>
          <div className="stat-value text-orange-600">{blockedMilestones.length}</div>
        </div>
        <div className="stat-card">
          <div className="flex items-center gap-2 mb-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-yellow-100">
              <svg className="w-4 h-4 text-yellow-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
            </div>
            <span className="text-xs font-medium text-gray-500">待审批</span>
          </div>
          <div className="stat-value text-yellow-600">{pendingDelayRequests?.length || 0}</div>
        </div>
        <div className="stat-card">
          <div className="flex items-center gap-2 mb-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-purple-100">
              <svg className="w-4 h-4 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
            </div>
            <span className="text-xs font-medium text-gray-500">总瓶颈</span>
          </div>
          <div className="stat-value text-purple-600">
            {Object.values(bottlenecksByRole).reduce((sum, count) => sum + count, 0)}
          </div>
        </div>
      </div>

      {/* Overdue & Blocked Grid */}
      <div className="grid gap-6 md:grid-cols-2 mb-8">
        {/* Overdue Milestones */}
        <div className="section">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-red-100">
              <span className="text-red-600">🕐</span>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900">超期节点</h2>
              <p className="text-sm text-gray-500">{overdueMilestones.length} 个进行中节点已超期</p>
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
                        <span className="font-medium text-gray-900 truncate">{milestone.orders?.order_no}</span>
                        <span className="badge badge-danger">超期</span>
                      </div>
                      <p className="text-sm text-gray-700 mb-1">{milestone.name}</p>
                      <div className="flex items-center gap-4 text-xs text-gray-500">
                        <span>截止: {formatDate(milestone.due_at)}</span>
                        <span>负责: {milestone.owner_role}</span>
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

        {/* Blocked Milestones */}
        <div className="section">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-orange-100">
              <span className="text-orange-600">🚫</span>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900">阻塞节点</h2>
              <p className="text-sm text-gray-500">{blockedMilestones.length} 个节点被阻塞</p>
            </div>
          </div>
          {blockedMilestones.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              <div className="text-3xl mb-2">✓</div>
              <p>暂无阻塞节点</p>
            </div>
          ) : (
            <div className="space-y-3 max-h-80 overflow-y-auto">
              {blockedMilestones.slice(0, 5).map((milestone: any) => (
                <Link
                  key={milestone.id}
                  href={`/orders/${milestone.order_id}#milestone-${milestone.id}`}
                  className="block p-4 rounded-xl border border-orange-200 hover:border-orange-300 bg-orange-50/50 transition-all hover:shadow-sm"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium text-gray-900 truncate">{milestone.orders?.order_no}</span>
                        <span className="badge badge-warning">阻塞</span>
                      </div>
                      <p className="text-sm text-gray-700 mb-1">{milestone.name}</p>
                      {milestone.notes && (
                        <p className="text-xs text-orange-700 bg-orange-100/50 rounded px-2 py-1 mt-1">
                          {milestone.notes.substring(0, 80)}...
                        </p>
                      )}
                    </div>
                    <svg className="w-5 h-5 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </div>
                </Link>
              ))}
              {blockedMilestones.length > 5 && (
                <p className="text-center text-sm text-indigo-600 font-medium py-2">
                  还有 {blockedMilestones.length - 5} 个阻塞节点...
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Pending Delay Requests */}
      <div className="section mb-8">
        <div className="flex items-center gap-3 mb-4">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-yellow-100">
            <span className="text-yellow-600">📋</span>
          </div>
          <div>
            <h2 className="text-lg font-semibold text-gray-900">待审批延期申请</h2>
            <p className="text-sm text-gray-500">{pendingDelayRequests?.length || 0} 个申请等待审批</p>
          </div>
        </div>
        {!pendingDelayRequests || pendingDelayRequests.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            <div className="text-3xl mb-2">✓</div>
            <p>暂无待审批延期申请</p>
          </div>
        ) : (
          <div className="space-y-4 max-h-[500px] overflow-y-auto">
            {pendingDelayRequests.map((request: any) => (
              <div
                key={request.id}
                className="p-5 rounded-xl border border-yellow-200 bg-yellow-50/50"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="font-semibold text-gray-900">
                        {request.milestones?.name || '未知节点'}
                      </span>
                      <span className="badge badge-warning">待审批</span>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-sm mb-3">
                      <div>
                        <span className="text-gray-500">订单:</span>{' '}
                        <Link href={`/orders/${request.milestones?.order_id}`} className="text-indigo-600 hover:text-indigo-700 font-medium">
                          {request.milestones?.orders?.order_no}
                        </Link>
                      </div>
                      <div>
                        <span className="text-gray-500">客户:</span>{' '}
                        <span className="text-gray-900">{request.milestones?.orders?.customer_name}</span>
                      </div>
                    </div>

                    <div className="bg-white rounded-lg p-3 border border-yellow-100 space-y-2">
                      <div className="text-sm">
                        <span className="text-gray-500">原因类型:</span>{' '}
                        <span className="font-medium text-gray-900">{request.reason_type}</span>
                      </div>
                      {request.reason_detail && (
                        <div className="text-sm">
                          <span className="text-gray-500">详细说明:</span>{' '}
                          <span className="text-gray-700">{request.reason_detail}</span>
                        </div>
                      )}
                      {request.proposed_new_anchor_date && (
                        <div className="text-sm">
                          <span className="text-gray-500">新锚点日期:</span>{' '}
                          <span className="font-medium text-indigo-600">{formatDate(request.proposed_new_anchor_date)}</span>
                        </div>
                      )}
                      {request.proposed_new_due_at && (
                        <div className="text-sm">
                          <span className="text-gray-500">新到期日期:</span>{' '}
                          <span className="font-medium text-indigo-600">{formatDate(request.proposed_new_due_at)}</span>
                        </div>
                      )}
                    </div>

                    {request.requires_customer_approval && (
                      <div className="mt-3 flex items-center gap-2 text-sm">
                        <span className="text-orange-700 font-medium">需要客户确认</span>
                        {request.customer_approval_evidence_url ? (
                          <span className="badge badge-success">✓ 已提供证据</span>
                        ) : (
                          <span className="badge badge-danger">⚠ 未提供证据</span>
                        )}
                      </div>
                    )}
                    {request.customer_approval_evidence_url && (
                      <div className="mt-2">
                        <a
                          href={request.customer_approval_evidence_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-sm text-indigo-600 hover:text-indigo-700"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                          </svg>
                          查看客户确认证据
                        </a>
                      </div>
                    )}
                    <div className="text-xs text-gray-400 mt-3">
                      提交时间: {formatDate(request.created_at)}
                    </div>
                  </div>
                  <div className="flex-shrink-0">
                    <DelayRequestActions delayRequestId={request.id} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Bottleneck Analysis Grid */}
      <div className="grid gap-6 md:grid-cols-2">
        {/* Bottleneck Summary by Role */}
        <div className="section">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-purple-100">
              <span className="text-purple-600">📊</span>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900">角色瓶颈分析</h2>
              <p className="text-sm text-gray-500">按责任角色统计</p>
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
                    <th>数量</th>
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
                            <span className="font-medium text-gray-900">{role}</span>
                          </td>
                          <td>
                            <span className="badge badge-danger">{count}</span>
                          </td>
                          <td>
                            <div className="flex items-center gap-2">
                              <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden max-w-16">
                                <div
                                  className="h-full bg-gradient-to-r from-purple-500 to-indigo-500 rounded-full"
                                  style={{ width: `${percentage}%` }}
                                />
                              </div>
                              <span className="text-xs text-gray-500">{percentage}%</span>
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

        {/* Bottleneck Summary by User */}
        <div className="section">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-blue-100">
              <span className="text-blue-600">👤</span>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900">用户瓶颈分析</h2>
              <p className="text-sm text-gray-500">按负责人统计</p>
            </div>
          </div>
          {Object.keys(bottlenecksByUser).length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              <div className="text-3xl mb-2">✓</div>
              <p>暂无瓶颈</p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-gray-200">
              <table className="table-modern">
                <thead>
                  <tr>
                    <th>用户</th>
                    <th>数量</th>
                    <th>操作</th>
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
                        <tr key={userId}>
                          <td>
                            <span className="font-medium text-gray-900">{displayName}</span>
                          </td>
                          <td>
                            <span className="badge badge-warning">{data.count}</span>
                          </td>
                          <td>
                            <Link
                              href={`/orders/${data.milestones[0]?.order_id || '#'}`}
                              className="inline-flex items-center gap-1 text-indigo-600 hover:text-indigo-700 text-sm font-medium"
                            >
                              查看
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                              </svg>
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
    </div>
  );
}
