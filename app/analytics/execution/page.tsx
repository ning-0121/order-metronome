'use client';

import { useState, useEffect } from 'react';
import { getExecutionAnalytics, type ExecutionSummary, type ExecutionScore } from '@/app/actions/execution-analytics';
import { ASSESSMENT_AWARDS, DEPARTMENTS } from '@/lib/config/assessment';
import { getRoleLabel } from '@/lib/utils/i18n';
import Link from 'next/link';

const GRADE_STYLES: Record<string, { bg: string; text: string; ring: string }> = {
  S: { bg: 'bg-purple-100', text: 'text-purple-700', ring: 'ring-purple-300' },
  A: { bg: 'bg-green-100', text: 'text-green-700', ring: 'ring-green-300' },
  B: { bg: 'bg-blue-100', text: 'text-blue-700', ring: 'ring-blue-300' },
  C: { bg: 'bg-amber-100', text: 'text-amber-700', ring: 'ring-amber-300' },
  D: { bg: 'bg-red-100', text: 'text-red-700', ring: 'ring-red-300' },
};

export default function ExecutionAnalyticsPage() {
  const [data, setData] = useState<ExecutionSummary | null>(null);
  const [period, setPeriod] = useState<'week' | 'month' | 'quarter'>('month');
  const [loading, setLoading] = useState(true);
  const [expandedUser, setExpandedUser] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    getExecutionAnalytics(period).then(res => {
      if (res.data) setData(res.data);
      setLoading(false);
    });
  }, [period]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="mb-2">
        <Link href="/analytics" className="text-sm text-gray-500 hover:text-indigo-600">← 数据分析</Link>
      </div>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">⚡ 执行力看板</h1>
          <p className="text-sm text-gray-500 mt-1">
            员工节点完成速度、逾期率、被升级次数 — 用数据说话
          </p>
        </div>
        <div className="flex gap-1">
          {([
            { value: 'week' as const, label: '本周' },
            { value: 'month' as const, label: '本月' },
            { value: 'quarter' as const, label: '本季' },
          ]).map(opt => (
            <button
              key={opt.value}
              onClick={() => setPeriod(opt.value)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                period === opt.value
                  ? 'bg-indigo-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-400">加载中...</div>
      ) : !data ? (
        <div className="text-center py-12 text-gray-400">暂无数据</div>
      ) : (
        <>
          {/* 考核基线横幅 + 概览 */}
          <div className="mb-4 rounded-xl bg-indigo-50 border border-indigo-200 p-3 text-sm text-indigo-800 flex items-center gap-3 flex-wrap">
            <span>🎯 <b>考核已启用</b>·自 <b>{data.baselineDate}</b>(本周一)起计,之前不追溯。</span>
            <span className="text-indigo-500">红线:当前逾期≥3 或 逾期率&gt;30% 即预警。</span>
          </div>
          <div className="grid grid-cols-3 gap-3 mb-5">
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-center">
              <div className="text-2xl font-bold text-emerald-600">{data.rankings.filter(r => r.qualified).length}</div>
              <div className="text-xs text-emerald-700 mt-0.5">达标(A/S · ≥75)</div>
            </div>
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-center">
              <div className="text-2xl font-bold text-rose-600">{data.rankings.filter(r => r.redLine).length}</div>
              <div className="text-xs text-rose-700 mt-0.5">🔴 红线预警</div>
            </div>
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-center">
              <div className="text-2xl font-bold text-amber-600">{data.rankings.filter(r => r.grade === 'D').length}</div>
              <div className="text-xs text-amber-700 mt-0.5">不合格(D)</div>
            </div>
          </div>

          {/* 团队平均 */}
          <div className="grid grid-cols-3 gap-4 mb-6">
            <div className="bg-white rounded-xl border border-gray-200 p-5 text-center">
              <div className="text-3xl font-bold text-indigo-600">{data.teamAvg.executionScore}</div>
              <div className="text-xs text-gray-500 mt-1">团队平均执行分</div>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 p-5 text-center">
              <div className="text-3xl font-bold text-gray-800">{data.teamAvg.avgResponseDays} 天</div>
              <div className="text-xs text-gray-500 mt-1">平均响应时间</div>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 p-5 text-center">
              <div className={`text-3xl font-bold ${data.teamAvg.overdueRate > 20 ? 'text-red-600' : data.teamAvg.overdueRate > 10 ? 'text-amber-600' : 'text-green-600'}`}>
                {data.teamAvg.overdueRate}%
              </div>
              <div className="text-xs text-gray-500 mt-1">团队逾期率</div>
            </div>
          </div>

          {/* 部门(主管)视图:部门均分算进主管头上 */}
          <div className="mb-6">
            <div className="text-sm font-semibold text-gray-700 mb-2">🏢 部门视图 <span className="text-xs font-normal text-gray-400">(部门平均分 = 主管的考核)</span></div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {DEPARTMENTS.map((dep) => {
                const members = data.rankings.filter((r) => r.roles.some((role) => dep.roles.includes(role)));
                const active = members.filter((m) => m.completedCount > 0);
                if (members.length === 0) return null;
                const avg = active.length > 0 ? Math.round(active.reduce((s, m) => s + m.executionScore, 0) / active.length) : 0;
                const qN = members.filter((m) => m.qualified).length;
                const laggards = members.filter((m) => m.redLine || m.grade === 'D');
                const avgCls = avg >= 75 ? 'text-emerald-600' : avg >= 60 ? 'text-amber-600' : 'text-rose-600';
                return (
                  <div key={dep.key} className="rounded-xl border border-gray-200 bg-white p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold text-gray-800">{dep.label}</span>
                      <span className={`text-2xl font-bold ${avgCls}`}>{avg}</span>
                    </div>
                    <div className="text-[11px] text-gray-500 mt-0.5">主管:{getRoleLabel(dep.managerRole)} · {active.length}/{members.length} 人有产出</div>
                    <div className="mt-1.5 flex items-center gap-2 text-xs">
                      <span className="text-emerald-600">达标 {qN}</span>
                      <span className="text-gray-300">·</span>
                      <span className={laggards.length > 0 ? 'text-rose-600' : 'text-gray-400'}>落后 {laggards.length}</span>
                    </div>
                    {laggards.length > 0 && (
                      <div className="mt-1 text-[11px] text-rose-500 truncate" title={laggards.map((m) => m.name).join('、')}>
                        ⚠️ {laggards.map((m) => m.name).join('、')}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* 排名表 */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-5 py-3 bg-gray-50 border-b border-gray-100">
              <span className="text-sm font-semibold text-gray-700">
                执行力排名（{data.period}）· {data.rankings.length} 人
              </span>
            </div>
            <div className="divide-y divide-gray-100">
              {data.rankings.map((r, idx) => {
                const g = GRADE_STYLES[r.grade] || GRADE_STYLES.C;
                const isExpanded = expandedUser === r.userId;
                return (
                  <div key={r.userId}>
                    <div
                      className="px-5 py-4 flex items-center gap-4 hover:bg-gray-50 cursor-pointer"
                      onClick={() => setExpandedUser(isExpanded ? null : r.userId)}
                    >
                      {/* 排名 */}
                      <div className="w-8 text-center">
                        {idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' :
                          <span className="text-sm text-gray-400">{idx + 1}</span>
                        }
                      </div>

                      {/* 评分 */}
                      <div className={`w-12 h-12 rounded-xl flex items-center justify-center text-lg font-bold ring-2 ${g.bg} ${g.text} ${g.ring}`}>
                        {r.grade}
                      </div>

                      {/* 姓名/角色 */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-semibold text-gray-900 text-sm">{r.name}</span>
                          {r.redLine && <span title={r.redLineReasons.join('；')} className="text-[10px] px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-700 font-medium">🔴 红线</span>}
                          {!r.redLine && r.qualified && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-medium">✅ 达标</span>}
                        </div>
                        <div className="text-xs text-gray-500">{r.roleLabel}</div>
                      </div>

                      {/* 关键指标 */}
                      <div className="hidden md:flex items-center gap-6 text-center">
                        <div>
                          <div className="text-lg font-bold text-gray-800">{r.executionScore}</div>
                          <div className="text-[10px] text-gray-400">执行分</div>
                        </div>
                        <div>
                          <div className="text-lg font-bold text-gray-800">{r.completedCount}</div>
                          <div className="text-[10px] text-gray-400">完成数</div>
                        </div>
                        <div>
                          <div className={`text-lg font-bold ${r.avgResponseDays > 2 ? 'text-red-600' : r.avgResponseDays > 1 ? 'text-amber-600' : 'text-green-600'}`}>
                            {r.avgResponseDays}天
                          </div>
                          <div className="text-[10px] text-gray-400">响应速度</div>
                        </div>
                        <div>
                          <div className={`text-lg font-bold ${r.overdueRate > 20 ? 'text-red-600' : r.overdueRate > 10 ? 'text-amber-600' : 'text-green-600'}`}>
                            {r.overdueRate}%
                          </div>
                          <div className="text-[10px] text-gray-400">逾期率</div>
                        </div>
                        <div>
                          <div className={`text-lg font-bold ${r.currentOverdueCount > 0 ? 'text-red-600' : 'text-green-600'}`}>
                            {r.currentOverdueCount}
                          </div>
                          <div className="text-[10px] text-gray-400">当前逾期</div>
                        </div>
                        <div>
                          <div className={`text-lg font-bold ${r.escalationCount > 0 ? 'text-red-600' : 'text-gray-300'}`}>
                            {r.escalationCount}
                          </div>
                          <div className="text-[10px] text-gray-400">被上报</div>
                        </div>
                      </div>

                      <span className="text-gray-300 text-xs">{isExpanded ? '▼' : '▶'}</span>
                    </div>

                    {/* 展开详情 */}
                    {isExpanded && (
                      <div className="px-5 py-4 bg-gray-50 border-t border-gray-100">
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                          <div className="bg-white rounded-lg border border-gray-200 p-3">
                            <div className="text-xs text-gray-500 mb-1">执行力评分</div>
                            <div className="flex items-center gap-2">
                              <div className={`text-2xl font-bold ${g.text}`}>{r.executionScore}</div>
                              <div className={`text-xs px-2 py-0.5 rounded-full ${g.bg} ${g.text} font-bold`}>{r.grade}</div>
                            </div>
                            <div className="text-[10px] text-gray-400 mt-1">
                              准时 40% + 速度 30% + 无逾期 20% + 无上报 10%
                            </div>
                          </div>
                          <div className="bg-white rounded-lg border border-gray-200 p-3">
                            <div className="text-xs text-gray-500 mb-1">响应时间</div>
                            <div className="text-lg font-bold text-gray-800">{r.avgResponseDays} 天</div>
                            <div className="text-[10px] text-gray-400">
                              最快 {r.fastestResponseDays} 天 · 最慢 {r.slowestResponseDays} 天
                            </div>
                          </div>
                          <div className="bg-white rounded-lg border border-gray-200 p-3">
                            <div className="text-xs text-gray-500 mb-1">逾期统计</div>
                            <div className="text-lg font-bold text-gray-800">{r.overdueCompletedCount} / {r.completedCount}</div>
                            <div className="text-[10px] text-gray-400">
                              逾期率 {r.overdueRate}%{r.currentOverdueCount > 0 ? ` · 当前逾期 ${r.currentOverdueCount} 项（共 ${r.totalOverdueDays} 天）` : ''}
                            </div>
                          </div>
                          <div className="bg-white rounded-lg border border-gray-200 p-3">
                            <div className="text-xs text-gray-500 mb-1">被升级次数</div>
                            <div className={`text-lg font-bold ${r.escalationCount > 0 ? 'text-red-600' : 'text-green-600'}`}>
                              {r.escalationCount} 次
                            </div>
                            <div className="text-[10px] text-gray-400">
                              {r.escalationCount === 0 ? '✅ 从未被上报' : '逾期 2 天以上被自动上报'}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* 月度奖励结算(仅经理/admin;涉及钱) */}
          {data.viewerCanSeeAwards && (() => {
            const rows = data.rankings.map((r, idx) => {
              const active = r.completedCount > 0;
              const qualifiedPay = active && r.qualified ? ASSESSMENT_AWARDS.qualified : 0;
              const rankPay = active && idx < ASSESSMENT_AWARDS.rank.length ? ASSESSMENT_AWARDS.rank[idx] : 0;
              const fullPay = active && !r.redLine && r.currentOverdueCount === 0 ? ASSESSMENT_AWARDS.fullAttendance : 0;
              return { r, idx, qualifiedPay, rankPay, fullPay, total: qualifiedPay + rankPay + fullPay };
            }).filter((a) => a.total > 0);
            const grand = rows.reduce((s, a) => s + a.total, 0);
            return (
              <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50/50 overflow-hidden">
                <div className="px-5 py-3 bg-amber-100/60 border-b border-amber-200 flex items-center justify-between flex-wrap gap-2">
                  <span className="text-sm font-bold text-amber-900">💰 {data.period}奖励结算</span>
                  <span className="text-xs text-amber-700">达标 ¥{ASSESSMENT_AWARDS.qualified} · 红榜 ¥{ASSESSMENT_AWARDS.rank.join('/')} · 全勤 ¥{ASSESSMENT_AWARDS.fullAttendance}｜建议按「本月」结算</span>
                </div>
                {rows.length === 0 ? (
                  <div className="px-5 py-6 text-center text-sm text-gray-400">本期暂无人达到奖励条件</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-gray-400 text-left border-b border-amber-100">
                          {['姓名', '角色', '达标奖', '红榜', '全勤', '合计'].map((h) => <th key={h} className="px-4 py-2 font-medium whitespace-nowrap">{h}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((a) => (
                          <tr key={a.r.userId} className="border-b border-amber-100/60">
                            <td className="px-4 py-2 font-medium text-gray-800 whitespace-nowrap">{a.r.name}{a.idx < 3 && <span className="ml-1">{['🥇', '🥈', '🥉'][a.idx]}</span>}</td>
                            <td className="px-4 py-2 text-gray-500 whitespace-nowrap">{a.r.roleLabel}</td>
                            <td className="px-4 py-2 text-gray-700">{a.qualifiedPay ? `¥${a.qualifiedPay}` : '—'}</td>
                            <td className="px-4 py-2 text-gray-700">{a.rankPay ? `¥${a.rankPay}` : '—'}</td>
                            <td className="px-4 py-2 text-gray-700">{a.fullPay ? `¥${a.fullPay}` : '—'}</td>
                            <td className="px-4 py-2 font-bold text-amber-700">¥{a.total}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="bg-amber-100/40">
                          <td colSpan={5} className="px-4 py-2 text-right font-semibold text-gray-700">本期奖励合计</td>
                          <td className="px-4 py-2 font-bold text-amber-800">¥{grand}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
                <p className="px-5 py-2 text-[11px] text-gray-400">达标=月分≥75且无红线;红榜=执行分前3;全勤=整月0红线0当前逾期。均需当期有产出。金额在 lib/config/assessment.ts 可调。</p>
              </div>
            );
          })()}

          {/* 说明 */}
          <div className="mt-6 text-xs text-gray-400 space-y-1">
            <p>📐 评分公式：准时率(40%) + 响应速度(30%) + 当前无逾期(20%) + 无升级(10%)</p>
            <p>🏆 S ≥ 90 · A ≥ 75 · B ≥ 60 · C ≥ 40 · D &lt; 40 ｜ ✅ 达标 = ≥75 且无红线</p>
            <p>🔴 红线(触发即预警,无论总分)：当前逾期 ≥ 3 项，或 逾期率 &gt; 30%</p>
            <p>🎯 考核自 {data.baselineDate}(本周一)起计，之前到期的节点不追溯（历史「没回填」不砸分）</p>
            <p>⏰ 响应时间 = 节点截止日到实际完成日的差值（提前完成算 0）</p>
          </div>
        </>
      )}
    </div>
  );
}
