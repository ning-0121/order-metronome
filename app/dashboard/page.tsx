import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { formatDate } from '@/lib/utils/date';
import Link from 'next/link';
import { UnblockButton } from '@/components/UnblockButton';

function getTodayDateString(): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today.toISOString().split('T')[0];
}

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('user_id', user.id)
    .single();

  const today = getTodayDateString();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];

  // 待复盘订单
  const { data: pendingRetroOrders } = await (supabase
    .from('orders') as any)
    .select('*')
    .eq('retrospective_required', true)
    .is('retrospective_completed_at', null)
    .order('created_at', { ascending: false });

  // 今日到期
  const { data: todayDueMilestones } = await (supabase
    .from('milestones') as any)
    .select(`*, orders!inner (id, order_no, customer_name)`)
    .gte('due_at', `${today}T00:00:00`)
    .lt('due_at', `${tomorrowStr}T00:00:00`)
    .neq('status', '已完成')
    .order('due_at', { ascending: true });

  // 已超期
  const { data: overdueMilestones } = await (supabase
    .from('milestones') as any)
    .select(`*, orders!inner (id, order_no, customer_name)`)
    .lt('due_at', `${today}T00:00:00`)
    .neq('status', '已完成')
    .order('due_at', { ascending: true });

  // 卡住清单
  const { data: blockedMilestones } = await (supabase
    .from('milestones') as any)
    .select(`*, orders!inner (id, order_no, customer_name)`)
    .eq('status', '卡住')
    .order('created_at', { ascending: false });

  const totalIssues =
    (pendingRetroOrders?.length || 0) +
    (overdueMilestones?.length || 0) +
    (todayDueMilestones?.length || 0) +
    (blockedMilestones?.length || 0);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">
          欢迎回来，{(profile as any)?.full_name || user.email?.split('@')[0]}
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          这里显示需要你关注的异常事项
        </p>
      </div>

      {/* Stats Overview */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <div className="stat-card">
          <div className="stat-value text-red-600">{overdueMilestones?.length || 0}</div>
          <div className="stat-label">已超期</div>
        </div>
        <div className="stat-card">
          <div className="stat-value text-blue-600">{todayDueMilestones?.length || 0}</div>
          <div className="stat-label">今日到期</div>
        </div>
        <div className="stat-card">
          <div className="stat-value text-orange-600">{blockedMilestones?.length || 0}</div>
          <div className="stat-label">已阻塞</div>
        </div>
        <div className="stat-card">
          <div className="stat-value text-purple-600">{pendingRetroOrders?.length || 0}</div>
          <div className="stat-label">待复盘</div>
        </div>
      </div>

      {/* All clear state */}
      {totalIssues === 0 && (
        <div className="section text-center py-16">
          <div className="text-6xl mb-4">🎉</div>
          <h2 className="text-xl font-bold text-gray-900 mb-2">暂无异常事项</h2>
          <p className="text-gray-500 mb-6">所有执行步骤都在正常进行中，继续保持！</p>
          <Link href="/orders" className="btn-primary inline-flex items-center gap-2">
            查看所有订单
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </Link>
        </div>
      )}

      {/* 已超期 - 最高优先级 */}
      {overdueMilestones && overdueMilestones.length > 0 && (
        <div className="section mb-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-red-100">
              <span className="text-red-600">⚠️</span>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900">已超期</h2>
              <p className="text-sm text-gray-500">{overdueMilestones.length} 个节点需要立即处理</p>
            </div>
          </div>
          <div className="space-y-3">
            {overdueMilestones.slice(0, 5).map((milestone: any) => (
              <MilestoneCard
                key={milestone.id}
                milestone={milestone}
                variant="danger"
                badge="超期"
              />
            ))}
            {overdueMilestones.length > 5 && (
              <Link href="/admin" className="block text-center text-sm text-indigo-600 hover:text-indigo-700 font-medium py-2">
                查看全部 {overdueMilestones.length} 个超期节点 →
              </Link>
            )}
          </div>
        </div>
      )}

      {/* 今日到期 */}
      {todayDueMilestones && todayDueMilestones.length > 0 && (
        <div className="section mb-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-blue-100">
              <span className="text-blue-600">📅</span>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900">今日到期</h2>
              <p className="text-sm text-gray-500">{todayDueMilestones.length} 个节点今日截止</p>
            </div>
          </div>
          <div className="space-y-3">
            {todayDueMilestones.slice(0, 5).map((milestone: any) => (
              <MilestoneCard
                key={milestone.id}
                milestone={milestone}
                variant="info"
                badge="今日"
              />
            ))}
          </div>
        </div>
      )}

      {/* 卡住清单 */}
      {blockedMilestones && blockedMilestones.length > 0 && (
        <div className="section mb-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-orange-100">
              <span className="text-orange-600">🚫</span>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900">已阻塞</h2>
              <p className="text-sm text-gray-500">{blockedMilestones.length} 个节点被阻塞</p>
            </div>
          </div>
          <div className="space-y-3">
            {blockedMilestones.slice(0, 5).map((milestone: any) => (
              <BlockedMilestoneCard key={milestone.id} milestone={milestone} />
            ))}
          </div>
        </div>
      )}

      {/* 待复盘 */}
      {pendingRetroOrders && pendingRetroOrders.length > 0 && (
        <div className="section mb-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-purple-100">
              <span className="text-purple-600">📋</span>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900">待复盘</h2>
              <p className="text-sm text-gray-500">{pendingRetroOrders.length} 个订单需要复盘</p>
            </div>
          </div>
          <div className="space-y-3">
            {pendingRetroOrders.slice(0, 5).map((order: any) => (
              <div key={order.id} className="flex items-center justify-between p-4 rounded-xl border border-gray-200 hover:border-purple-300 transition-colors">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900">{order.order_no}</span>
                    <span className="badge badge-info">待复盘</span>
                  </div>
                  <p className="text-sm text-gray-500 mt-1">客户: {order.customer_name}</p>
                </div>
                <Link
                  href={`/orders/${order.id}/retrospective`}
                  className="btn-primary text-sm py-2"
                >
                  去复盘
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MilestoneCard({ milestone, variant, badge }: { milestone: any; variant: 'danger' | 'info'; badge: string }) {
  const order = milestone.orders;
  const borderClass = variant === 'danger' ? 'border-red-200 hover:border-red-300' : 'border-blue-200 hover:border-blue-300';
  const badgeClass = variant === 'danger' ? 'badge-danger' : 'badge-info';

  return (
    <Link
      href={`/orders/${order?.id}#milestone-${milestone.id}`}
      className={`block p-4 rounded-xl border ${borderClass} transition-all hover:shadow-sm`}
    >
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-medium text-gray-900 truncate">{order?.order_no}</span>
            <span className={`badge ${badgeClass}`}>{badge}</span>
          </div>
          <p className="text-sm text-gray-700 mb-1">{milestone.name}</p>
          <div className="flex items-center gap-4 text-xs text-gray-500">
            <span>截止: {milestone.due_at ? formatDate(milestone.due_at) : '-'}</span>
            <span>负责: {milestone.owner_role}</span>
          </div>
        </div>
        <svg className="w-5 h-5 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </div>
    </Link>
  );
}

function BlockedMilestoneCard({ milestone }: { milestone: any }) {
  const order = milestone.orders;
  const blockedReason = milestone.notes?.startsWith('卡住原因：')
    ? milestone.notes.substring(5)
    : milestone.notes || '未填写原因';

  return (
    <div className="p-4 rounded-xl border border-orange-200 hover:border-orange-300 transition-all">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-medium text-gray-900 truncate">{order?.order_no}</span>
            <span className="badge badge-warning">阻塞</span>
          </div>
          <p className="text-sm text-gray-700 mb-2">{milestone.name}</p>
          <div className="text-xs text-orange-700 bg-orange-50 rounded-lg px-3 py-2">
            原因: {blockedReason}
          </div>
        </div>
        <div className="flex flex-col gap-2 ml-4">
          <UnblockButton milestoneId={milestone.id} />
          <Link
            href={`/orders/${order?.id}#milestone-${milestone.id}`}
            className="text-xs text-indigo-600 hover:text-indigo-700 font-medium"
          >
            查看 →
          </Link>
        </div>
      </div>
    </div>
  );
}
