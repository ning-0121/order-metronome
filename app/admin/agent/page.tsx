import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import { formatDate } from '@/lib/utils/date';
import Link from 'next/link';

export default async function AgentDashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) redirect('/dashboard');

  // 统计数据
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();

  const [totalRes, executedRes, dismissedRes, expiredRes, todayRes, weekRes, recentRes] = await Promise.all([
    (supabase.from('agent_actions') as any).select('id', { count: 'exact', head: true }),
    (supabase.from('agent_actions') as any).select('id', { count: 'exact', head: true }).eq('status', 'executed'),
    (supabase.from('agent_actions') as any).select('id', { count: 'exact', head: true }).eq('status', 'dismissed'),
    (supabase.from('agent_actions') as any).select('id', { count: 'exact', head: true }).eq('status', 'expired'),
    (supabase.from('agent_actions') as any).select('id', { count: 'exact', head: true }).gte('created_at', today + 'T00:00:00Z'),
    (supabase.from('agent_actions') as any).select('id', { count: 'exact', head: true }).gte('created_at', weekAgo),
    (supabase.from('agent_actions') as any)
      .select('id, order_id, action_type, title, status, severity, executed_by, executed_at, dismissed_at, created_at, rolled_back')
      .order('created_at', { ascending: false })
      .limit(30),
  ]);

  const total = totalRes.count || 0;
  const executed = executedRes.count || 0;
  const dismissed = dismissedRes.count || 0;
  const expired = expiredRes.count || 0;
  const pending = total - executed - dismissed - expired;
  const todayCount = todayRes.count || 0;
  const weekCount = weekRes.count || 0;
  const execRate = (executed + dismissed) > 0 ? Math.round((executed / (executed + dismissed)) * 100) : 0;

  // 按类型统计
  const { data: byType } = await (supabase.from('agent_actions') as any)
    .select('action_type, status');
  const typeStats: Record<string, { total: number; executed: number; dismissed: number }> = {};
  for (const a of byType || []) {
    if (!typeStats[a.action_type]) typeStats[a.action_type] = { total: 0, executed: 0, dismissed: 0 };
    typeStats[a.action_type].total++;
    if (a.status === 'executed') typeStats[a.action_type].executed++;
    if (a.status === 'dismissed') typeStats[a.action_type].dismissed++;
  }

  // 操作人映射
  const execUserIds = [...new Set((recentRes.data || []).map((a: any) => a.executed_by).filter(Boolean))];
  let userMap: Record<string, string> = {};
  if (execUserIds.length > 0) {
    const { data: profiles } = await (supabase.from('profiles') as any).select('user_id, name, email').in('user_id', execUserIds);
    userMap = (profiles || []).reduce((m: any, p: any) => { m[p.user_id] = p.name || p.email?.split('@')[0]; return m; }, {});
  }

  const typeLabels: Record<string, string> = {
    assign_owner: '👤 分配负责人', send_nudge: '📧 催办', create_delay_draft: '⏱ 延期申请',
    mark_blocked: '🚧 标记阻塞', add_note: '📝 备注', escalate_ceo: '🚨 升级CEO',
    notify_next: '📢 通知下一节点', remind_missing_doc: '📎 缺失文件',
  };
  const statusStyles: Record<string, string> = {
    pending: 'bg-amber-100 text-amber-700', executing: 'bg-blue-100 text-blue-700',
    executed: 'bg-green-100 text-green-700', dismissed: 'bg-gray-100 text-gray-500', expired: 'bg-gray-100 text-gray-400',
  };
  const statusLabels: Record<string, string> = {
    pending: '待处理', executing: '执行中', executed: '已执行', dismissed: '已忽略', expired: '已过期',
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">🤖 Agent 监控面板</h1>
        <p className="text-sm text-gray-500 mt-1">AI Agent 活动追踪、执行率、建议质量</p>
      </div>

      {/* 总览 */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3 mb-6">
        <div className="bg-white rounded-xl border border-gray-200 p-4 text-center">
          <div className="text-2xl font-bold text-gray-900">{total}</div>
          <div className="text-xs text-gray-500">总建议</div>
        </div>
        <div className="bg-white rounded-xl border border-green-200 p-4 text-center">
          <div className="text-2xl font-bold text-green-600">{executed}</div>
          <div className="text-xs text-gray-500">已执行</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4 text-center">
          <div className="text-2xl font-bold text-gray-400">{dismissed}</div>
          <div className="text-xs text-gray-500">已忽略</div>
        </div>
        <div className="bg-white rounded-xl border border-amber-200 p-4 text-center">
          <div className="text-2xl font-bold text-amber-600">{pending}</div>
          <div className="text-xs text-gray-500">待处理</div>
        </div>
        <div className="bg-white rounded-xl border border-indigo-200 p-4 text-center">
          <div className={`text-2xl font-bold ${execRate >= 60 ? 'text-green-600' : execRate >= 30 ? 'text-amber-600' : 'text-red-600'}`}>{execRate}%</div>
          <div className="text-xs text-gray-500">执行率</div>
        </div>
        <div className="bg-white rounded-xl border border-blue-200 p-4 text-center">
          <div className="text-2xl font-bold text-blue-600">{todayCount}</div>
          <div className="text-xs text-gray-500">今日建议</div>
        </div>
        <div className="bg-white rounded-xl border border-purple-200 p-4 text-center">
          <div className="text-2xl font-bold text-purple-600">{weekCount}</div>
          <div className="text-xs text-gray-500">本周建议</div>
        </div>
      </div>

      {/* 按类型统计 */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 mb-6">
        <h2 className="font-bold text-gray-900 mb-4">📊 按动作类型统计</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Object.entries(typeStats).sort((a, b) => b[1].total - a[1].total).map(([type, stats]) => {
            const rate = (stats.executed + stats.dismissed) > 0 ? Math.round((stats.executed / (stats.executed + stats.dismissed)) * 100) : 0;
            return (
              <div key={type} className="p-3 bg-gray-50 rounded-lg">
                <div className="text-sm font-medium text-gray-900">{typeLabels[type] || type}</div>
                <div className="flex items-center justify-between mt-1">
                  <span className="text-lg font-bold text-gray-700">{stats.total}</span>
                  <span className={`text-xs font-medium ${rate >= 50 ? 'text-green-600' : 'text-amber-600'}`}>
                    执行率 {rate}%
                  </span>
                </div>
                <div className="flex gap-2 text-xs text-gray-400 mt-1">
                  <span className="text-green-600">{stats.executed}执行</span>
                  <span>{stats.dismissed}忽略</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 最近活动 */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-5 py-3 bg-gray-50 border-b border-gray-200">
          <h2 className="font-bold text-gray-900">📋 最近 Agent 活动</h2>
        </div>
        <div className="divide-y divide-gray-100">
          {(recentRes.data || []).map((a: any) => (
            <div key={a.id} className="px-5 py-3 flex items-center justify-between">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusStyles[a.status] || ''}`}>
                    {statusLabels[a.status] || a.status}
                  </span>
                  <span className="text-xs text-gray-500">{typeLabels[a.action_type] || a.action_type}</span>
                  {a.rolled_back && <span className="text-xs px-1.5 py-0.5 rounded bg-red-100 text-red-600">已回滚</span>}
                </div>
                <p className="text-sm text-gray-900 mt-0.5 truncate">{a.title}</p>
                <div className="flex items-center gap-3 text-xs text-gray-400 mt-0.5">
                  <span>{formatDate(a.created_at)}</span>
                  {a.executed_by && <span>执行人: {userMap[a.executed_by] || '未知'}</span>}
                </div>
              </div>
              <Link href={`/orders/${a.order_id}`} className="text-xs text-indigo-600 hover:underline shrink-0 ml-3">
                查看订单
              </Link>
            </div>
          ))}
          {(recentRes.data || []).length === 0 && (
            <div className="px-5 py-8 text-center text-gray-400 text-sm">Agent 尚未生成任何建议</div>
          )}
        </div>
      </div>
    </div>
  );
}
