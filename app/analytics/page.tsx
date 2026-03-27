import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { getAnalyticsSummary, getPhaseEfficiency, getRoleEfficiency } from '@/app/actions/analytics';

export default async function AnalyticsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [summary, phases, roles] = await Promise.all([
    getAnalyticsSummary(),
    getPhaseEfficiency(),
    getRoleEfficiency(),
  ]);

  const weekDelta = summary.thisWeekCompleted - summary.lastWeekCompleted;
  const weekDeltaStr = weekDelta > 0 ? `+${weekDelta}` : `${weekDelta}`;
  const weekDeltaColor = weekDelta >= 0 ? 'text-green-600' : 'text-red-600';

  // 找出最慢阶段
  const slowestPhase = phases.length > 0
    ? phases.reduce((prev, curr) => (curr.onTimeRate < prev.onTimeRate && curr.completedCount > 0) ? curr : prev)
    : null;

  return (
    <div className="min-h-screen bg-gray-50 p-4 md:p-6 space-y-6">
      {/* 头部 */}
      <div>
        <h1 className="text-2xl md:text-3xl font-bold text-gray-900">📊 效率分析</h1>
        <p className="text-gray-500 text-sm mt-1">基于真实执行数据，展示各环节效率与系统价值</p>
      </div>

      {/* KPI 卡片 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {/* 准时率 */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="text-xs text-gray-500 uppercase tracking-wide">订单节点准时率</div>
          <div className="text-3xl font-bold text-indigo-600 mt-2">{summary.onTimeRate}%</div>
          <div className="text-xs text-gray-400 mt-1">{summary.onTimeCount} / {summary.completedMilestones} 按时完成</div>
        </div>

        {/* 完成率 */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="text-xs text-gray-500 uppercase tracking-wide">整体完成率</div>
          <div className="text-3xl font-bold text-green-600 mt-2">{summary.completionRate}%</div>
          <div className="text-xs text-gray-400 mt-1">{summary.completedMilestones} / {summary.totalMilestones} 节点</div>
        </div>

        {/* 本周完成 */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="text-xs text-gray-500 uppercase tracking-wide">本周完成节点</div>
          <div className="flex items-baseline gap-2 mt-2">
            <span className="text-3xl font-bold text-blue-600">{summary.thisWeekCompleted}</span>
            <span className={`text-sm font-medium ${weekDeltaColor}`}>
              {weekDelta >= 0 ? '↑' : '↓'} {weekDeltaStr}
            </span>
          </div>
          <div className="text-xs text-gray-400 mt-1">上周 {summary.lastWeekCompleted}</div>
        </div>

        {/* 当前风险 */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="text-xs text-gray-500 uppercase tracking-wide">当前风险</div>
          <div className="flex items-baseline gap-3 mt-2">
            <span className="text-xl font-bold text-red-600">{summary.overdueCount} 超期</span>
            <span className="text-xl font-bold text-orange-600">{summary.blockedCount} 阻塞</span>
          </div>
          <div className="text-xs text-gray-400 mt-1">共 {summary.totalOrders} 个订单追踪中</div>
        </div>
      </div>

      {/* 各阶段效率 */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="bg-gray-50 px-5 py-3 border-b border-gray-200">
          <h2 className="text-lg font-bold text-gray-900">各阶段效率</h2>
          <p className="text-xs text-gray-500">每个阶段的完成情况和准时率</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200 text-sm text-gray-600">
                <th className="text-left px-5 py-3 font-medium">阶段</th>
                <th className="text-center px-4 py-3 font-medium">完成 / 总数</th>
                <th className="text-center px-4 py-3 font-medium">准时率</th>
                <th className="text-left px-4 py-3 font-medium w-40">进度</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {phases.map(p => {
                const pct = p.totalCount > 0 ? Math.round(p.completedCount / p.totalCount * 100) : 0;
                const isSlowest = slowestPhase && p.phase === slowestPhase.phase && p.completedCount > 0;
                return (
                  <tr key={p.phase} className={isSlowest ? 'bg-orange-50' : ''}>
                    <td className="px-5 py-3">
                      <span className="font-medium text-gray-900 text-sm">{p.phase}</span>
                      {isSlowest && <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-orange-100 text-orange-700">最慢环节</span>}
                    </td>
                    <td className="text-center px-4 py-3 text-sm text-gray-700">
                      {p.completedCount} / {p.totalCount}
                    </td>
                    <td className="text-center px-4 py-3">
                      <span className={`text-sm font-semibold ${
                        p.onTimeRate >= 80 ? 'text-green-600' :
                        p.onTimeRate >= 50 ? 'text-yellow-600' : 'text-red-600'
                      }`}>
                        {p.completedCount > 0 ? `${p.onTimeRate}%` : '—'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="w-full bg-gray-200 rounded-full h-2">
                        <div
                          className={`h-2 rounded-full ${pct === 100 ? 'bg-green-500' : 'bg-indigo-500'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="text-xs text-gray-400">{pct}%</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* 各角色效率 */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="bg-gray-50 px-5 py-3 border-b border-gray-200">
          <h2 className="text-lg font-bold text-gray-900">各角色效率</h2>
          <p className="text-xs text-gray-500">每个角色的完成数、超期数和准时率</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200 text-sm text-gray-600">
                <th className="text-left px-5 py-3 font-medium">角色</th>
                <th className="text-center px-4 py-3 font-medium">已完成</th>
                <th className="text-center px-4 py-3 font-medium">超期中</th>
                <th className="text-center px-4 py-3 font-medium">准时率</th>
                <th className="text-left px-4 py-3 font-medium w-32">表现</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {roles.map(r => (
                <tr key={r.role}>
                  <td className="px-5 py-3">
                    <span className="font-medium text-gray-900 text-sm">{r.roleLabel}</span>
                  </td>
                  <td className="text-center px-4 py-3 text-sm text-green-700 font-medium">{r.completedCount}</td>
                  <td className="text-center px-4 py-3">
                    <span className={`text-sm font-medium ${r.overdueCount > 0 ? 'text-red-600' : 'text-gray-400'}`}>
                      {r.overdueCount}
                    </span>
                  </td>
                  <td className="text-center px-4 py-3">
                    <span className={`text-sm font-semibold ${
                      r.onTimeRate >= 80 ? 'text-green-600' :
                      r.onTimeRate >= 50 ? 'text-yellow-600' : 'text-red-600'
                    }`}>
                      {r.completedCount > 0 ? `${r.onTimeRate}%` : '—'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {r.completedCount > 0 && (
                      <div className="flex items-center gap-1">
                        {r.onTimeRate >= 80 ? (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700">优秀</span>
                        ) : r.onTimeRate >= 50 ? (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-700">需改善</span>
                        ) : (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700">待提升</span>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 软件价值摘要 */}
      <div className="bg-gradient-to-r from-indigo-50 to-purple-50 rounded-xl border border-indigo-200 p-6">
        <h2 className="text-lg font-bold text-indigo-900 mb-3">💡 订单节拍器 · 系统价值</h2>
        <div className="grid md:grid-cols-3 gap-4 text-sm">
          <div className="bg-white/70 rounded-lg p-4">
            <div className="text-2xl font-bold text-indigo-600">{summary.totalOrders}</div>
            <div className="text-gray-600 mt-1">个订单正在追踪</div>
            <div className="text-xs text-gray-400 mt-2">每个订单 22 个控制节点，全程数字化管理</div>
          </div>
          <div className="bg-white/70 rounded-lg p-4">
            <div className="text-2xl font-bold text-green-600">{summary.totalMilestones}</div>
            <div className="text-gray-600 mt-1">个控制节点已生成</div>
            <div className="text-xs text-gray-400 mt-2">自动排期、自动预警、不漏一个环节</div>
          </div>
          <div className="bg-white/70 rounded-lg p-4">
            <div className="text-2xl font-bold text-purple-600">{summary.onTimeRate}%</div>
            <div className="text-gray-600 mt-1">节点准时完成率</div>
            <div className="text-xs text-gray-400 mt-2">实时监控交期风险，提前预警延误</div>
          </div>
        </div>
        <div className="mt-4 text-xs text-gray-500">
          卡风险，而不是走流程 — 订单节拍器帮助团队将交期管理从被动响应转变为主动预防。
        </div>
      </div>
    </div>
  );
}
