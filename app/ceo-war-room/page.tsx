import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import Link from 'next/link';
import { analyzeWarRoom } from '@/lib/warRoom/rootCauseEngine';
import { suggestActions, summarizeActions } from '@/lib/warRoom/actionEngine';
import type { WarRoomOrder } from '@/lib/warRoom/rootCauseEngine';
import type { SuggestedAction } from '@/lib/warRoom/actionEngine';

const RISK_CONFIG = {
  CRITICAL: { label: '极高风险', color: 'text-red-700', bg: 'bg-red-50', border: 'border-red-300', dot: 'bg-red-500' },
  HIGH:     { label: '高风险',   color: 'text-orange-700', bg: 'bg-orange-50', border: 'border-orange-300', dot: 'bg-orange-500' },
  MEDIUM:   { label: '中风险',   color: 'text-yellow-700', bg: 'bg-yellow-50', border: 'border-yellow-200', dot: 'bg-yellow-400' },
  LOW:      { label: '低风险',   color: 'text-green-700', bg: 'bg-green-50', border: 'border-green-200', dot: 'bg-green-400' },
};

const ACTION_ICONS: Record<string, string> = {
  ASSIGN_OWNER:      '👤',
  ESCALATE:          '🚨',
  NOTIFY_CLIENT:     '📧',
  PRIORITIZE:        '⚡',
  UNBLOCK:           '🔓',
  EXPEDITE_SOURCING: '🏃',
  REQUEST_EXTENSION: '📅',
  QC_INTERVENTION:   '🔬',
  LOGISTICS_ALERT:   '🚢',
};

const PRIORITY_STYLE = {
  IMMEDIATE: { label: '立即处理', color: 'text-red-700 bg-red-100 border-red-200' },
  TODAY:     { label: '今日内',   color: 'text-orange-700 bg-orange-100 border-orange-200' },
  THIS_WEEK: { label: '本周内',   color: 'text-blue-700 bg-blue-100 border-blue-200' },
};

export default async function WarRoomPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) redirect('/dashboard');

  // 获取所有订单 + 里程碑
  const { data: orders } = await supabase
    .from('orders')
    .select('id, order_no, customer_name, incoterm, etd, eta, warehouse_due_date, cancel_date, order_type')
    .order('created_at', { ascending: false });

  const ordersWithMilestones = [];
  for (const o of (orders || []) as any[]) {
    const { data: milestones } = await supabase
      .from('milestones')
      .select('id, step_key, name, owner_role, owner_user_id, due_at, status, is_critical, sequence_number')
      .eq('order_id', o.id)
      .order('sequence_number', { ascending: true });
    ordersWithMilestones.push({ ...o, milestones: milestones || [] });
  }

  // 运行分析引擎
  const warRoomData = analyzeWarRoom(ordersWithMilestones as any);
  const top3 = warRoomData.slice(0, 3);
  const allActions = suggestActions(top3);
  const summary = summarizeActions(allActions);

  const totalOrders = warRoomData.length;
  const criticalCount = warRoomData.filter(w => w.riskLevel === 'CRITICAL').length;
  const highCount = warRoomData.filter(w => w.riskLevel === 'HIGH').length;

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* 顶栏 */}
      <div className="border-b border-gray-800 bg-gray-900 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-red-600 text-lg">⚔️</div>
            <div>
              <h1 className="text-lg font-bold text-white">CEO War Room</h1>
              <p className="text-xs text-gray-400">决策驾驶舱 · 规则引擎驱动 · 实时风险分析</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <Link href="/ceo" className="text-xs text-gray-400 hover:text-white transition-colors">
              ← 返回 CEO 看板
            </Link>
            <span className="text-xs text-gray-500">
              {new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-8 space-y-8">

        {/* 顶部统计行 */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[
            { label: '在途订单', value: totalOrders, sub: '全部监控中', color: 'text-white' },
            { label: '极高风险', value: criticalCount, sub: '需立即介入', color: 'text-red-400' },
            { label: '高风险',   value: highCount,    sub: '需今日跟进', color: 'text-orange-400' },
            { label: '立即处理', value: summary.immediate, sub: '条行动建议', color: 'text-yellow-400' },
          ].map(item => (
            <div key={item.label} className="rounded-xl bg-gray-900 border border-gray-800 p-4">
              <p className="text-xs text-gray-400 mb-1">{item.label}</p>
              <p className={`text-3xl font-bold ${item.color}`}>{item.value}</p>
              <p className="text-xs text-gray-500 mt-1">{item.sub}</p>
            </div>
          ))}
        </div>

        {/* 主内容：Top 3 + 行动建议 */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">

          {/* Left：Top 3 高危订单 */}
          <div className="lg:col-span-3 space-y-4">
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-widest">
              🔥 Top 3 高危订单
            </h2>

            {top3.length === 0 ? (
              <div className="rounded-xl bg-gray-900 border border-gray-800 p-8 text-center">
                <p className="text-4xl mb-3">✅</p>
                <p className="text-gray-400">所有订单风险可控，暂无需要介入的高危订单</p>
              </div>
            ) : top3.map((wr, idx) => {
              const cfg = RISK_CONFIG[wr.riskLevel];
              const anchor = wr.order.etd || wr.order.eta || wr.order.warehouse_due_date;
              return (
                <div key={wr.order.id}
                  className="rounded-xl bg-gray-900 border border-gray-800 overflow-hidden">
                  {/* 订单头部 */}
                  <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
                    <div className="flex items-center gap-3">
                      <span className="text-2xl font-black text-gray-600">#{idx + 1}</span>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-white">{wr.order.order_no}</span>
                          <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${cfg.color} ${cfg.bg.replace('bg-','bg-opacity-10 bg-').replace('50','900')} border-opacity-30`}
                            style={{background:'rgba(239,68,68,0.15)', borderColor:'rgba(239,68,68,0.3)'}}>
                            {cfg.label}
                          </span>
                        </div>
                        <p className="text-xs text-gray-400 mt-0.5">
                          {wr.order.customer_name} · {wr.order.incoterm}
                          {anchor && (' · ETD: ' + new Date(anchor).toLocaleDateString('zh-CN'))}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-lg font-bold text-red-400">{wr.riskScore}</p>
                      <p className="text-xs text-gray-500">风险分</p>
                    </div>
                  </div>

                  {/* 快速指标 */}
                  <div className="grid grid-cols-3 divide-x divide-gray-800 border-b border-gray-800">
                    {[
                      { label: '逾期节点', value: wr.overdueCount, alert: wr.overdueCount > 0 },
                      { label: '阻塞节点', value: wr.blockedCount, alert: wr.blockedCount > 0 },
                      { label: '无负责人', value: wr.unassignedCriticalCount, alert: wr.unassignedCriticalCount > 0 },
                    ].map(stat => (
                      <div key={stat.label} className="px-4 py-3 text-center">
                        <p className={`text-xl font-bold ${stat.alert ? 'text-red-400' : 'text-gray-500'}`}>
                          {stat.value}
                        </p>
                        <p className="text-xs text-gray-500">{stat.label}</p>
                      </div>
                    ))}
                  </div>

                  {/* 根因分析 */}
                  <div className="px-5 py-4 space-y-2">
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">根因分析</p>
                    {wr.rootCauses.length === 0 ? (
                      <p className="text-xs text-gray-500">未检测到明显根因</p>
                    ) : wr.rootCauses.slice(0, 3).map(cause => (
                      <div key={cause.code} className="flex items-start gap-2.5 py-1.5">
                        <span className={`mt-0.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                          cause.severity === 'CRITICAL' ? 'bg-red-500' :
                          cause.severity === 'HIGH' ? 'bg-orange-400' : 'bg-yellow-400'
                        }`} />
                        <div className="flex-1 min-w-0">
                          <span className="text-xs font-medium text-gray-200">{cause.label}</span>
                          <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{cause.detail}</p>
                          {cause.affectedRoles.length > 0 && (
                            <div className="flex gap-1 mt-1 flex-wrap">
                              {cause.affectedRoles.map(r => (
                                <span key={r} className="text-xs px-1.5 py-0.5 rounded bg-gray-800 text-gray-400">{r}</span>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* 查看订单按钮 */}
                  <div className="px-5 pb-4">
                    <Link href={`/orders/${wr.order.id}?tab=timeline`}
                      className="block w-full text-center py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-xs text-gray-300 font-medium transition-colors">
                      进入订单执行页 →
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Right：行动建议列表 */}
          <div className="lg:col-span-2 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-widest">
                ⚡ 行动建议
              </h2>
              <span className="text-xs text-gray-500">{allActions.length} 条</span>
            </div>

            {/* 优先级汇总 */}
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg bg-red-950 border border-red-900 px-3 py-2 text-center">
                <p className="text-xl font-bold text-red-400">{summary.immediate}</p>
                <p className="text-xs text-red-600">立即处理</p>
              </div>
              <div className="rounded-lg bg-orange-950 border border-orange-900 px-3 py-2 text-center">
                <p className="text-xl font-bold text-orange-400">{summary.today}</p>
                <p className="text-xs text-orange-600">今日内</p>
              </div>
            </div>

            {/* 行动卡片列表 */}
            <div className="space-y-3 max-h-[70vh] overflow-y-auto pr-1">
              {allActions.length === 0 ? (
                <div className="rounded-xl bg-gray-900 border border-gray-800 p-6 text-center">
                  <p className="text-2xl mb-2">✅</p>
                  <p className="text-xs text-gray-500">暂无需要处理的行动建议</p>
                </div>
              ) : allActions.map(action => {
                const pri = PRIORITY_STYLE[action.priority];
                return (
                  <div key={action.id}
                    className="rounded-xl bg-gray-900 border border-gray-800 p-4 hover:border-gray-700 transition-colors">
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="flex items-center gap-2">
                        <span className="text-base">{ACTION_ICONS[action.type] || '📌'}</span>
                        <span className="text-sm font-medium text-white">{action.label}</span>
                      </div>
                      <span className={`text-xs px-2 py-0.5 rounded-full border font-medium flex-shrink-0 ${pri.color}`}>
                        {pri.label}
                      </span>
                    </div>
                    <p className="text-xs text-gray-400 leading-relaxed mb-3">{action.description}</p>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs text-gray-600">订单：</span>
                        <span className="text-xs text-gray-400 font-mono">{action.orderNo}</span>
                        <span className="text-xs text-gray-600 ml-1">→ {action.targetRole}</span>
                      </div>
                      <Link href={action.ctaHref}
                        className="text-xs px-3 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition-colors">
                        {action.ctaLabel}
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* 全局瓶颈热力图 */}
        {warRoomData.length > 0 && (() => {
          const roleMap: Record<string, { overdue: number; blocked: number }> = {};
          for (const wr of warRoomData) {
            for (const m of wr.order.milestones) {
              const role = m.owner_role;
              if (!roleMap[role]) roleMap[role] = { overdue: 0, blocked: 0 };
              if (m.status !== '已完成' && m.due_at && new Date(m.due_at) < new Date()) roleMap[role].overdue++;
              if (m.status === '阻塞') roleMap[role].blocked++;
            }
          }
          const roleLabels: Record<string,string> = { sales:'业务',finance:'财务',procurement:'采购',production:'生产',qc:'质检',logistics:'物流',admin:'管理' };
          const sorted = Object.entries(roleMap)
            .map(([r, v]) => ({ role: r, label: roleLabels[r]||r, ...v, total: v.overdue+v.blocked }))
            .filter(r => r.total > 0)
            .sort((a,b) => b.total - a.total);
          if (sorted.length === 0) return null;
          const maxTotal = sorted[0].total;
          return (
            <div>
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-widest mb-4">
                📊 部门瓶颈热力图
              </h2>
              <div className="rounded-xl bg-gray-900 border border-gray-800 p-5">
                <div className="space-y-3">
                  {sorted.map(r => (
                    <div key={r.role} className="flex items-center gap-4">
                      <span className="w-16 text-xs text-gray-400 text-right flex-shrink-0">{r.label}</span>
                      <div className="flex-1 flex gap-1">
                        <div className="h-6 rounded flex items-center justify-end pr-2 transition-all"
                          style={{ width: `${(r.overdue/maxTotal*100)}%`, background: 'rgba(239,68,68,0.4)', minWidth: r.overdue > 0 ? '2rem' : '0' }}>
                          {r.overdue > 0 && <span className="text-xs text-red-300 font-medium">{r.overdue}</span>}
                        </div>
                        {r.blocked > 0 && (
                          <div className="h-6 rounded flex items-center justify-end pr-2"
                            style={{ width: `${(r.blocked/maxTotal*60)}%`, background: 'rgba(251,146,60,0.4)', minWidth: '2rem' }}>
                            <span className="text-xs text-orange-300 font-medium">{r.blocked}</span>
                          </div>
                        )}
                      </div>
                      <span className="text-xs text-gray-500 w-8">{r.total}</span>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-4 mt-4 pt-3 border-t border-gray-800">
                  <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded" style={{background:'rgba(239,68,68,0.5)'}}/><span className="text-xs text-gray-500">逾期</span></div>
                  <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded" style={{background:'rgba(251,146,60,0.5)'}}/><span className="text-xs text-gray-500">阻塞</span></div>
                </div>
              </div>
            </div>
          );
        })()}

      </div>
    </div>
  );
}
