import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import Link from 'next/link';
import { analyzeWarRoom } from '@/lib/warRoom/rootCauseEngine';
import { suggestActions, summarizeActions, CATEGORY_CONFIG } from '@/lib/warRoom/actionEngine';

const RISK_CONFIG = {
  CRITICAL: { label: 'CRITICAL',  badge: 'bg-red-600 text-white',       bar: 'bg-red-500',    ring: 'ring-red-700' },
  HIGH:     { label: 'HIGH',      badge: 'bg-orange-500 text-white',     bar: 'bg-orange-400', ring: 'ring-orange-700' },
  MEDIUM:   { label: 'MEDIUM',    badge: 'bg-yellow-500 text-gray-900',  bar: 'bg-yellow-400', ring: 'ring-yellow-700' },
  LOW:      { label: 'LOW',       badge: 'bg-gray-600 text-gray-200',    bar: 'bg-gray-500',   ring: 'ring-gray-700' },
};

export default async function WarRoomPage() {
  // V1 收敛：War Room 已合并至 /admin 管理看板「问题中心」Tab
  redirect('/admin');

  // ── 以下代码保留但不再可达 ──
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) redirect('/dashboard');

  const { data: orders } = await supabase
    .from('orders')
    .select('id, order_no, customer_name, incoterm, etd, eta, warehouse_due_date, cancel_date, order_type')
    .order('created_at', { ascending: false });

  const ordersWithMilestones: any[] = [];
  for (const o of (orders || []) as any[]) {
    const { data: ms } = await supabase
      .from('milestones')
      .select('id, step_key, name, owner_role, owner_user_id, due_at, status, is_critical, sequence_number')
      .eq('order_id', o.id)
      .order('sequence_number', { ascending: true });
    ordersWithMilestones.push({ ...o, milestones: ms || [] });
  }

  const warRoomData = analyzeWarRoom(ordersWithMilestones as any);
  // CEO 只看前2个最危急订单
  const focusOrders = warRoomData.slice(0, 2);
  const allActions = suggestActions(focusOrders);
  const summary = summarizeActions(allActions);

  const criticalCount = warRoomData.filter(w => w.riskLevel === 'CRITICAL').length;
  const highCount     = warRoomData.filter(w => w.riskLevel === 'HIGH').length;
  const clearCount    = (orders?.length || 0) - warRoomData.length;

  // 部门瓶颈（全局）
  const roleMap: Record<string, { overdue: number; blocked: number }> = {};
  for (const wr of warRoomData) {
    for (const m of wr.order.milestones) {
      if (m.status === '已完成') continue;
      const r = m.owner_role;
      if (!roleMap[r]) roleMap[r] = { overdue: 0, blocked: 0 };
      if (m.status !== '已完成' && m.due_at && new Date(m.due_at) < new Date()) roleMap[r].overdue++;
      if (m.status === '阻塞') roleMap[r].blocked++;
    }
  }
  const RLABELS: Record<string,string> = {sales:'业务',finance:'财务',procurement:'采购',production:'生产',qc:'质检',logistics:'物流'};
  const heatRows = Object.entries(roleMap)
    .map(([r,v]) => ({ role:r, label:RLABELS[r]||r, total:v.overdue+v.blocked, ...v }))
    .filter(r => r.total > 0)
    .sort((a,b) => b.total - a.total);
  const heatMax = heatRows[0]?.total || 1;

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* 顶栏 */}
      <div className="border-b border-gray-800 bg-gray-900 px-6 py-4 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl">⚔️</span>
            <div>
              <h1 className="text-base font-bold text-white tracking-tight">CEO War Room</h1>
              <p className="text-xs text-gray-500">决策驾驶舱 · 规则引擎 · {new Date().toLocaleDateString('zh-CN',{month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'})}</p>
            </div>
          </div>
          <Link href="/ceo" className="text-xs text-gray-500 hover:text-gray-300 transition-colors">← 返回看板</Link>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 py-7 space-y-7">

        {/* 态势概览 — 4格 */}
        <div className="grid grid-cols-4 gap-3">
          {[
            { label: 'CRITICAL', value: criticalCount, sub: '需立即决策', color: criticalCount > 0 ? 'text-red-400' : 'text-gray-500' },
            { label: 'HIGH',     value: highCount,     sub: '需今日跟进', color: highCount > 0 ? 'text-orange-400' : 'text-gray-500' },
            { label: '运转正常', value: clearCount,    sub: '风险可控',   color: 'text-green-500' },
            { label: '行动建议', value: summary.total, sub: `其中 ${summary.immediate} 条立即`, color: summary.immediate > 0 ? 'text-yellow-400' : 'text-gray-400' },
          ].map(s => (
            <div key={s.label} className="rounded-xl bg-gray-900 border border-gray-800 px-4 py-3">
              <p className="text-xs text-gray-500 mb-1">{s.label}</p>
              <p className={`text-3xl font-black ${s.color}`}>{s.value}</p>
              <p className="text-xs text-gray-600 mt-0.5">{s.sub}</p>
            </div>
          ))}
        </div>

        {/* 无需介入状态 */}
        {focusOrders.length === 0 && (
          <div className="rounded-2xl bg-gray-900 border border-gray-800 p-12 text-center">
            <p className="text-5xl mb-4">✅</p>
            <p className="text-lg font-semibold text-white mb-2">所有订单风险可控</p>
            <p className="text-sm text-gray-500">当前无需 CEO 介入的决策事项</p>
          </div>
        )}

        {/* 核心区：订单卡 + 行动建议（联动布局） */}
        {focusOrders.map((wr, idx) => {
          const cfg = RISK_CONFIG[wr.riskLevel];
          const anchor = wr.order.etd || wr.order.eta || wr.order.warehouse_due_date;
          const orderActions = allActions.filter(a => a.orderId === wr.order.id);

          return (
            <div key={wr.order.id}
              className={`rounded-2xl bg-gray-900 border border-gray-800 ring-1 overflow-hidden ${cfg.ring}`}>

              {/* 订单头 */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
                <div className="flex items-center gap-4">
                  <span className="text-3xl font-black text-gray-700 select-none">#{idx+1}</span>
                  <div>
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="font-bold text-white text-base">{wr.order.order_no}</span>
                      <span className={`text-xs font-bold px-2 py-0.5 rounded ${cfg.badge}`}>{cfg.label}</span>
                    </div>
                    <p className="text-xs text-gray-500">
                      {wr.order.customer_name} · {wr.order.incoterm}
                      {anchor && (' · ETD ' + new Date(anchor).toLocaleDateString('zh-CN'))}
                      {wr.daysToAnchor !== null && (
                        <span className={wr.daysToAnchor <= 7 ? ' text-red-400 font-semibold' : ' text-gray-400'}>
                          {wr.daysToAnchor <= 0 ? '（已过出货日）' : ` （还有 ${wr.daysToAnchor} 天）`}
                        </span>
                      )}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-2xl font-black text-gray-400">{wr.riskScore}</p>
                  <p className="text-xs text-gray-600">风险分</p>
                </div>
              </div>

              {/* 主体：左=根因 右=行动 */}
              <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-gray-800">

                {/* 左：根因分析 */}
                <div className="px-6 py-5">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-4">根因分析</p>

                  {/* 快速指标 */}
                  <div className="grid grid-cols-3 gap-2 mb-5">
                    {[
                      { label: '逾期节点', v: wr.overdueCount,              alert: wr.overdueCount > 0 },
                      { label: '阻塞节点', v: wr.blockedCount,              alert: wr.blockedCount > 0 },
                      { label: '无负责人', v: wr.unassignedCriticalCount,   alert: wr.unassignedCriticalCount >= 3 },
                    ].map(s => (
                      <div key={s.label} className="rounded-lg bg-gray-800 px-3 py-2 text-center">
                        <p className={`text-xl font-bold ${s.alert ? 'text-red-400' : 'text-gray-500'}`}>{s.v}</p>
                        <p className="text-xs text-gray-600">{s.label}</p>
                      </div>
                    ))}
                  </div>

                  {/* 根因列表（最多3条，压缩展示） */}
                  <div className="space-y-3">
                    {wr.rootCauses.length === 0 ? (
                      <p className="text-xs text-gray-600">未检出明显根因</p>
                    ) : wr.rootCauses.map(cause => (
                      <div key={cause.code} className="flex gap-2.5">
                        <span className={`mt-1 w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                          cause.severity === 'CRITICAL' ? 'bg-red-500' :
                          cause.severity === 'HIGH' ? 'bg-orange-400' : 'bg-yellow-400'
                        }`} />
                        <div>
                          <p className="text-xs font-semibold text-gray-200">{cause.label}</p>
                          <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{cause.detail}</p>
                          {cause.impactedStages.length > 0 && (
                            <div className="flex gap-1 mt-1.5 flex-wrap">
                              {cause.impactedStages.map(s => (
                                <span key={s} className="text-xs px-1.5 py-0.5 rounded bg-gray-800 text-gray-500">{s}</span>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 右：行动建议（最多3条） */}
                <div className="px-6 py-5">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-4">
                    行动建议 <span className="text-gray-700 normal-case font-normal">（{orderActions.length} 条）</span>
                  </p>
                  <div className="space-y-3">
                    {orderActions.length === 0 ? (
                      <p className="text-xs text-gray-600">暂无建议</p>
                    ) : orderActions.map(action => {
                      const catCfg = CATEGORY_CONFIG[action.category];
                      return (
                        <div key={action.id}
                          className="rounded-xl border border-gray-800 bg-gray-800/50 p-4">
                          <div className="flex items-start justify-between gap-2 mb-2">
                            <div className="flex items-center gap-1.5">
                              <span className="text-sm">{action.icon}</span>
                              <span className="text-xs font-semibold text-white">{action.label}</span>
                            </div>
                            <span className={`text-xs px-2 py-0.5 rounded-full border font-medium flex-shrink-0 ${catCfg.style}`}>
                              {catCfg.label}
                            </span>
                          </div>
                          <p className="text-xs text-gray-400 leading-relaxed mb-3">{action.description}</p>
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-gray-600">→ {action.targetRole}</span>
                            <Link href={action.ctaHref}
                              className="text-xs px-3 py-1.5 rounded-lg bg-indigo-700 hover:bg-indigo-600 text-white font-medium transition-colors">
                              {action.ctaLabel}
                            </Link>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          );
        })}

        {/* 其余高风险订单：折叠摘要列表 */}
        {warRoomData.length > 2 && (
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-3">其他关注订单</p>
            <div className="rounded-xl bg-gray-900 border border-gray-800 divide-y divide-gray-800">
              {warRoomData.slice(2).map(wr => {
                const cfg = RISK_CONFIG[wr.riskLevel];
                const anchor = wr.order.etd || wr.order.eta || wr.order.warehouse_due_date;
                return (
                  <Link key={wr.order.id} href={`/orders/${wr.order.id}?tab=progress`}
                    className="flex items-center justify-between px-5 py-3.5 hover:bg-gray-800 transition-colors group">
                    <div className="flex items-center gap-3">
                      <span className={`text-xs font-bold px-2 py-0.5 rounded ${cfg.badge}`}>{cfg.label}</span>
                      <span className="text-sm font-medium text-gray-300">{wr.order.order_no}</span>
                      <span className="text-xs text-gray-600">{wr.order.customer_name}</span>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-gray-600">
                      {anchor && <span>{new Date(anchor).toLocaleDateString('zh-CN')}</span>}
                      <span className="text-gray-700 group-hover:text-gray-400">→</span>
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        )}

        {/* 部门瓶颈热力图 */}
        {heatRows.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-3">部门瓶颈热力图</p>
            <div className="rounded-xl bg-gray-900 border border-gray-800 px-6 py-5 space-y-3">
              {heatRows.map(r => (
                <div key={r.role} className="flex items-center gap-4">
                  <span className="w-12 text-xs text-gray-500 text-right flex-shrink-0">{r.label}</span>
                  <div className="flex-1 flex items-center gap-1 h-5">
                    {r.overdue > 0 && (
                      <div className="h-full rounded flex items-center justify-end pr-2"
                        style={{ width: `${Math.max(8, r.overdue/heatMax*100)}%`, background:'rgba(239,68,68,0.35)' }}>
                        <span className="text-xs text-red-400 font-medium">{r.overdue}</span>
                      </div>
                    )}
                    {r.blocked > 0 && (
                      <div className="h-full rounded flex items-center justify-end pr-2"
                        style={{ width: `${Math.max(6, r.blocked/heatMax*60)}%`, background:'rgba(251,146,60,0.4)' }}>
                        <span className="text-xs text-orange-400 font-medium">{r.blocked}</span>
                      </div>
                    )}
                  </div>
                  <span className="text-xs text-gray-600 w-6 text-right">{r.total}</span>
                </div>
              ))}
              <div className="flex gap-4 pt-2 border-t border-gray-800">
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-3 rounded" style={{background:'rgba(239,68,68,0.5)'}}/><span className="text-xs text-gray-600">逾期</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-3 rounded" style={{background:'rgba(251,146,60,0.5)'}}/><span className="text-xs text-gray-600">阻塞</span>
                </div>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
