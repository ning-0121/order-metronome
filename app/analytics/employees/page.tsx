'use client';

import { useState, useEffect } from 'react';
import { getEmployeeRanking, getEmployeeAnalytics, type EmployeeRanking, type EmployeeAnalytics } from '@/app/actions/analytics-detail';
import Link from 'next/link';

const PERIODS = [
  { value: 'month' as const, label: '本月' },
  { value: 'quarter' as const, label: '本季' },
  { value: 'year' as const, label: '本年' },
];

const GRADE_COLORS: Record<string, string> = {
  S: 'bg-purple-100 text-purple-700',
  A: 'bg-green-100 text-green-700',
  B: 'bg-blue-100 text-blue-700',
  C: 'bg-amber-100 text-amber-700',
  D: 'bg-red-100 text-red-700',
};

export default function EmployeeAnalyticsPage() {
  const [rankings, setRankings] = useState<EmployeeRanking[]>([]);
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [period, setPeriod] = useState<'month' | 'quarter' | 'year'>('year');
  const [detail, setDetail] = useState<EmployeeAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    getEmployeeRanking().then(res => {
      setRankings(res.data);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!selectedUser) { setDetail(null); return; }
    setDetailLoading(true);
    getEmployeeAnalytics(selectedUser, period).then(res => {
      setDetail(res.data || null);
      setDetailLoading(false);
    });
  }, [selectedUser, period]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      {/* 头部 */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">👥 员工分析</h1>
          <p className="text-sm text-gray-500 mt-1">业务/跟单绩效排行与 AI 分析</p>
        </div>
        <Link href="/analytics/customers" className="text-sm text-indigo-600 hover:text-indigo-700">
          客户分析 →
        </Link>
      </div>

      {loading && <div className="text-center py-12 text-gray-400">加载中...</div>}

      {!loading && (
        <div className="space-y-6">
          {/* 排行榜 */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-700">绩效排行</h3>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-left">
                  <th className="px-5 py-2.5 font-medium text-gray-600 w-8">#</th>
                  <th className="px-5 py-2.5 font-medium text-gray-600">姓名</th>
                  <th className="px-5 py-2.5 font-medium text-gray-600">角色</th>
                  <th className="px-5 py-2.5 font-medium text-gray-600 text-center">在手订单</th>
                  <th className="px-5 py-2.5 font-medium text-gray-600 text-center">总订单</th>
                  <th className="px-5 py-2.5 font-medium text-gray-600 text-center">平均评分</th>
                  <th className="px-5 py-2.5 font-medium text-gray-600 text-center">准时率</th>
                  <th className="px-5 py-2.5 font-medium text-gray-600"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rankings.map((r, i) => (
                  <tr
                    key={r.userId}
                    className={`hover:bg-gray-50 cursor-pointer ${selectedUser === r.userId ? 'bg-indigo-50' : ''}`}
                    onClick={() => setSelectedUser(selectedUser === r.userId ? null : r.userId)}
                  >
                    <td className="px-5 py-3 text-gray-400 font-medium">{i + 1}</td>
                    <td className="px-5 py-3 font-semibold text-gray-900">{r.name}</td>
                    <td className="px-5 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${r.role === '业务/理单' ? 'bg-indigo-100 text-indigo-700' : 'bg-purple-100 text-purple-700'}`}>
                        {r.role}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-center text-blue-600 font-medium">{r.activeCount}</td>
                    <td className="px-5 py-3 text-center text-gray-700">{r.orderCount}</td>
                    <td className="px-5 py-3 text-center">
                      <span className={`font-bold ${r.avgScore >= 85 ? 'text-green-600' : r.avgScore >= 75 ? 'text-amber-600' : r.avgScore > 0 ? 'text-red-600' : 'text-gray-400'}`}>
                        {r.avgScore || '—'}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-center text-gray-600">{r.onTimeRate > 0 ? `${r.onTimeRate}%` : '—'}</td>
                    <td className="px-5 py-3 text-right">
                      <span className="text-xs text-indigo-500">{selectedUser === r.userId ? '收起' : '详情'}</span>
                    </td>
                  </tr>
                ))}
                {rankings.length === 0 && (
                  <tr><td colSpan={8} className="px-5 py-8 text-center text-gray-400">暂无数据</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {/* 详细分析 */}
          {selectedUser && (
            <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
              {/* 时间范围 */}
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-bold text-gray-900">
                  {detail?.name || '加载中...'}
                  {detail?.role && <span className="ml-2 text-sm font-normal text-gray-500">({detail.role})</span>}
                </h3>
                <div className="flex rounded-lg bg-gray-100 p-0.5">
                  {PERIODS.map(p => (
                    <button
                      key={p.value}
                      onClick={() => setPeriod(p.value)}
                      className={`px-3 py-1.5 text-sm font-medium rounded-md transition-all ${
                        period === p.value ? 'bg-white text-indigo-700 shadow-sm' : 'text-gray-500'
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              {detailLoading && <div className="text-center py-8 text-gray-400">加载中...</div>}

              {!detailLoading && detail && (
                <>
                  {/* 概览 */}
                  <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
                    {[
                      { label: '在手订单', value: detail.activeOrders, color: 'text-blue-600' },
                      { label: '已完成', value: detail.completedOrders, color: 'text-green-600' },
                      { label: '总数量', value: `${detail.totalQuantity}件`, color: 'text-gray-800' },
                      { label: '平均评分', value: detail.avgScore || '—', color: detail.avgScore >= 85 ? 'text-green-600' : 'text-amber-600' },
                      { label: '准时率', value: `${detail.onTimeRate}%`, color: detail.onTimeRate >= 80 ? 'text-green-600' : 'text-red-600' },
                      { label: '延期次数', value: detail.delayCount, color: detail.delayCount > 2 ? 'text-red-600' : 'text-gray-600' },
                    ].map(item => (
                      <div key={item.label} className="bg-gray-50 rounded-lg p-3 text-center">
                        <div className={`text-xl font-bold ${item.color}`}>{item.value}</div>
                        <div className="text-xs text-gray-500 mt-0.5">{item.label}</div>
                      </div>
                    ))}
                  </div>

                  {/* AI 分析 */}
                  <div className="bg-gradient-to-br from-slate-50 to-white rounded-xl border border-slate-100 p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-lg">🧠</span>
                      <span className="text-sm font-semibold text-gray-700">AI 绩效分析</span>
                    </div>
                    <p className="text-sm text-gray-600 leading-relaxed">{detail.aiSummary}</p>
                  </div>

                  {/* 评分等级分布 */}
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-gray-500">评分等级分布：</span>
                    {Object.entries(detail.gradeDistribution).map(([grade, count]) => (
                      count > 0 && (
                        <span key={grade} className={`px-2.5 py-1 rounded-lg text-xs font-bold ${GRADE_COLORS[grade]}`}>
                          {grade} × {count}
                        </span>
                      )
                    ))}
                    {Object.values(detail.gradeDistribution).every(v => v === 0) && (
                      <span className="text-sm text-gray-400">暂无评分数据</span>
                    )}
                  </div>

                  {/* 月度趋势 */}
                  {detail.monthlyTrend.length > 0 && (
                    <div>
                      <h4 className="text-sm font-semibold text-gray-700 mb-2">月度趋势</h4>
                      <div className="flex items-end gap-2 h-24">
                        {detail.monthlyTrend.map(m => {
                          const maxScore = 100;
                          const h = (m.score / maxScore) * 100;
                          return (
                            <div key={m.month} className="flex-1 flex flex-col items-center gap-1">
                              <span className="text-xs font-medium text-indigo-600">{m.score}</span>
                              <div className="w-full rounded-t-md bg-indigo-500" style={{ height: `${Math.max(h, 4)}%` }} />
                              <span className="text-[10px] text-gray-400">{m.month.slice(5)}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
