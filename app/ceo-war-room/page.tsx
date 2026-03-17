import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import { getTopCriticalOrders } from '@/lib/warroom/engine';
import type { OrderWarRoomAnalysis } from '@/lib/warroom/engine';
import Link from 'next/link';

const ACTION_CONFIG = {
  assign_owner:    { icon: '👤', color: 'indigo' },
  escalate:        { icon: '🚨', color: 'red'    },
  notify_client:   { icon: '📧', color: 'blue'   },
  prioritize:      { icon: '⬆️', color: 'orange' },
  expedite_material: { icon: '📦', color: 'amber' },
  push_booking:    { icon: '🚢', color: 'teal'   },
  internal_meeting:{ icon: '🤝', color: 'purple' },
};

const URGENCY_LABEL = {
  immediate: { text: '立即处理', cls: 'bg-red-100 text-red-700' },
  today:     { text: '今日内',   cls: 'bg-amber-100 text-amber-700' },
  this_week: { text: '本周内',   cls: 'bg-blue-100 text-blue-700' },
};

const ROOT_CAUSE_ICON: Record<string, string> = {
  chain_delay:     '🔗',
  role_bottleneck: '⚠️',
  no_owner:        '👻',
  blocked_critical:'🚫',
  etd_at_risk:     '⏰',
  overdue_cascade: '📉',
};

function RiskBadge({ level, score }: { level: string; score: number }) {
  const cfg = level === 'CRITICAL'
    ? 'bg-red-600 text-white'
    : level === 'HIGH'
    ? 'bg-orange-500 text-white'
    : 'bg-amber-400 text-white';
  const label = level === 'CRITICAL' ? '🔴 高危' : level === 'HIGH' ? '🟠 高风险' : '🟡 关注';
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-semibold ${cfg}`}>
      {label}
      <span className="text-xs opacity-80">({score}分)</span>
    </span>
  );
}

function ScoreBar({ score }: { score: number }) {
  const color = score >= 70 ? 'bg-red-500' : score >= 40 ? 'bg-orange-400' : 'bg-amber-400';
  return (
    <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
      <div className={`h-full rounded-full transition-all ${color}`} style={{ width: score + '%' }} />
    </div>
  );
}

function OrderCard({ analysis, rank }: { analysis: OrderWarRoomAnalysis; rank: number }) {
  const rankColor = rank === 1 ? 'border-red-400 bg-red-50' : rank === 2 ? 'border-orange-300 bg-orange-50' : 'border-amber-200 bg-amber-50';

  return (
    <div className={`rounded-2xl border-2 ${rankColor} overflow-hidden`}>
      {/* 订单头部 */}
      <div className="px-6 py-4 flex items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <div className={`flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center text-lg font-bold ${
            rank === 1 ? 'bg-red-600 text-white' : rank === 2 ? 'bg-orange-500 text-white' : 'bg-amber-400 text-white'
          }`}>
            {rank}
          </div>
          <div>
            <div className="flex items-center gap-3 flex-wrap">
              <Link href={`/orders/${analysis.orderId}`}
                className="text-lg font-bold text-gray-900 hover:text-indigo-600">
                {analysis.orderNo}
              </Link>
              <span className="text-sm text-gray-500">{analysis.customerName}</span>
              <RiskBadge level={analysis.riskLevel} score={analysis.riskScore} />
            </div>
            <p className="text-sm text-gray-700 mt-1">{analysis.warRoomSummary}</p>
          </div>
        </div>
        <div className="text-right flex-shrink-0">
          {analysis.daysToEtd !== null && (
            <div className={`text-2xl font-bold ${
              analysis.daysToEtd < 0 ? 'text-red-600' :
              analysis.daysToEtd <= 7 ? 'text-orange-600' : 'text-gray-700'
            }`}>
              {analysis.daysToEtd < 0 ? '已逾期' : analysis.daysToEtd + '天'}
            </div>
          )}
          <div className="text-xs text-gray-400 mt-0.5">
            {analysis.daysToEtd !== null && analysis.daysToEtd >= 0 ? '距ETD' : 'ETD状态'}
          </div>
        </div>
      </div>

      {/* 风险评分条 */}
      <div className="px-6 pb-2">
        <ScoreBar score={analysis.riskScore} />
      </div>

      {/* 三栏统计 */}
      <div className="px-6 py-3 grid grid-cols-3 gap-3 border-t border-b border-gray-200 bg-white">
        <div className="text-center">
          <div className={`text-2xl font-bold ${analysis.overdueCount > 0 ? 'text-red-600' : 'text-gray-400'}`}>
            {analysis.overdueCount}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">逾期节点</div>
        </div>
        <div className="text-center border-x border-gray-100">
          <div className={`text-2xl font-bold ${analysis.blockedCount > 0 ? 'text-orange-600' : 'text-gray-400'}`}>
            {analysis.blockedCount}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">阻塞节点</div>
        </div>
        <div className="text-center">
          <div className={`text-2xl font-bold ${analysis.unownedCriticalCount > 0 ? 'text-amber-600' : 'text-gray-400'}`}>
            {analysis.unownedCriticalCount}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">无主关键节点</div>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-0 divide-y md:divide-y-0 md:divide-x divide-gray-100">
        {/* 根因分析 */}
        <div className="px-6 py-4">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">
            根因分析
          </h3>
          {analysis.rootCauses.length === 0 ? (
            <p className="text-sm text-gray-400">暂无明显根因</p>
          ) : (
            <ul className="space-y-2">
              {analysis.rootCauses.slice(0, 3).map((cause, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <span className="flex-shrink-0 mt-0.5">{ROOT_CAUSE_ICON[cause.type] || '•'}</span>
                  <div>
                    <span className={`inline-block text-xs px-1.5 py-0.5 rounded mr-1.5 font-medium ${
                      cause.severity === 1 ? 'bg-red-100 text-red-700' :
                      cause.severity === 2 ? 'bg-orange-100 text-orange-700' :
                      'bg-gray-100 text-gray-600'
                    }`}>
                      {cause.severity === 1 ? '严重' : cause.severity === 2 ? '警告' : '提示'}
                    </span>
                    <span className="text-gray-700">{cause.description}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* 行动建议 */}
        <div className="px-6 py-4">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">
            建议行动
          </h3>
          {analysis.suggestedActions.length === 0 ? (
            <p className="text-sm text-gray-400">暂无建议行动</p>
          ) : (
            <div className="space-y-2">
              {analysis.suggestedActions.slice(0, 4).map((action, i) => {
                const urgencyInfo = URGENCY_LABEL[action.urgency];
                const actionCfg = ACTION_CONFIG[action.type as keyof typeof ACTION_CONFIG];
                return (
                  <div key={i} className="flex items-start gap-2 p-2 rounded-lg bg-white border border-gray-100 hover:border-indigo-200 hover:bg-indigo-50 transition-colors">
                    <span className="flex-shrink-0 text-base mt-0.5">{actionCfg?.icon || '→'}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-gray-900">{action.label}</span>
                        <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${urgencyInfo.cls}`}>
                          {urgencyInfo.text}
                        </span>
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{action.description}</p>
                    </div>
                    <Link href={`/orders/${analysis.orderId}?tab=timeline`}
                      className="flex-shrink-0 text-xs text-indigo-600 hover:text-indigo-700 font-medium mt-1">
                      处理 →
                    </Link>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default async function CeoWarRoomPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) redirect('/dashboard');

  // 获取所有订单及节点
  const { data: orders } = await supabase
    .from('orders')
    .select('*')
    .order('created_at', { ascending: false });

  const ordersWithMilestones: Array<{ order: any; milestones: any[] }> = [];
  if (orders) {
    for (const order of orders as any[]) {
      const { data: milestones } = await supabase
        .from('milestones')
        .select('*')
        .eq('order_id', order.id);
      ordersWithMilestones.push({ order, milestones: milestones || [] });
    }
  }

  const topOrders = getTopCriticalOrders(ordersWithMilestones, 3);
  const totalOrders = orders?.length || 0;
  const criticalCount = topOrders.filter(o => o.riskLevel === 'CRITICAL').length;
  const highCount = topOrders.filter(o => o.riskLevel === 'HIGH').length;
  const totalOverdue = topOrders.reduce((s, o) => s + o.overdueCount, 0);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* 页头 */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-6 py-5">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-red-600 flex items-center justify-center text-white text-xl">
                  🎯
                </div>
                <div>
                  <h1 className="text-xl font-bold text-gray-900">CEO War Room</h1>
                  <p className="text-sm text-gray-500">Top 3 高危订单 · 根因分析 · 行动建议</p>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Link href="/ceo"
                className="text-sm text-gray-500 hover:text-gray-700 px-3 py-1.5 rounded-lg hover:bg-gray-100">
                ← 返回总览
              </Link>
              <span className="text-xs text-gray-400">
                {new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 更新
              </span>
            </div>
          </div>

          {/* 全局摘要 */}
          <div className="mt-4 grid grid-cols-4 gap-3">
            {[
              { label: '在跟订单', value: totalOrders, color: 'text-gray-900' },
              { label: '高危订单', value: criticalCount, color: criticalCount > 0 ? 'text-red-600' : 'text-gray-400' },
              { label: '高风险订单', value: highCount, color: highCount > 0 ? 'text-orange-600' : 'text-gray-400' },
              { label: 'Top3 逾期节点', value: totalOverdue, color: totalOverdue > 0 ? 'text-red-600' : 'text-gray-400' },
            ].map(({ label, value, color }) => (
              <div key={label} className="bg-gray-50 rounded-xl px-4 py-3">
                <div className={`text-2xl font-bold ${color}`}>{value}</div>
                <div className="text-xs text-gray-500 mt-0.5">{label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 主体 */}
      <div className="max-w-5xl mx-auto px-6 py-6 space-y-5">
        {topOrders.length === 0 ? (
          <div className="text-center py-20 bg-white rounded-2xl border border-gray-200">
            <div className="text-5xl mb-4">✅</div>
            <h2 className="text-xl font-semibold text-gray-900 mb-2">所有订单运行正常</h2>
            <p className="text-gray-500">当前没有高风险订单需要干预</p>
          </div>
        ) : (
          topOrders.map((analysis, i) => (
            <OrderCard key={analysis.orderId} analysis={analysis} rank={i + 1} />
          ))
        )}

        {/* 底部说明 */}
        <div className="text-center text-xs text-gray-400 py-4 space-y-1">
          <p>风险评分 = 逾期节点（×8）+ 阻塞节点（×15）+ 无主关键节点（×5）+ ETD 压力加成，满分100</p>
          <p>≥70 → 高危 · ≥40 → 高风险 · &lt;40 → 关注</p>
        </div>
      </div>
    </div>
  );
}
