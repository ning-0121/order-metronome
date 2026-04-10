'use client';

import { useState, useEffect } from 'react';
import { getExecutionAnalytics, type ExecutionSummary, type ExecutionScore } from '@/app/actions/execution-analytics';
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
                        <div className="font-semibold text-gray-900 text-sm">{r.name}</div>
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

          {/* 说明 */}
          <div className="mt-6 text-xs text-gray-400 space-y-1">
            <p>📐 评分公式：准时率(40%) + 响应速度(30%) + 当前无逾期(20%) + 无升级(10%)</p>
            <p>🏆 S ≥ 90 · A ≥ 75 · B ≥ 60 · C ≥ 40 · D &lt; 40</p>
            <p>⏰ 响应时间 = 节点截止日到实际完成日的差值（提前完成算 0）</p>
            <p>🔴 被上报 = 逾期超过 2 天被自动升级链触发</p>
          </div>
        </>
      )}
    </div>
  );
}
