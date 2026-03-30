'use client';

import { useState, useEffect } from 'react';
import { getCustomerList, getCustomerAnalytics, type CustomerAnalytics } from '@/app/actions/analytics-detail';
import Link from 'next/link';

const PERIODS = [
  { value: 'month' as const, label: '本月' },
  { value: 'quarter' as const, label: '本季' },
  { value: 'year' as const, label: '本年' },
];

export default function CustomerAnalyticsPage() {
  const [customers, setCustomers] = useState<{ name: string; orderCount: number }[]>([]);
  const [selected, setSelected] = useState('');
  const [period, setPeriod] = useState<'month' | 'quarter' | 'year'>('year');
  const [data, setData] = useState<CustomerAnalytics | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    getCustomerList().then(res => {
      setCustomers(res.data);
      if (res.data.length > 0 && !selected) setSelected(res.data[0].name);
    });
  }, []);

  useEffect(() => {
    if (!selected) return;
    setLoading(true);
    getCustomerAnalytics(selected, period).then(res => {
      setData(res.data || null);
      setLoading(false);
    });
  }, [selected, period]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      {/* 头部 */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">📊 客户分析</h1>
          <p className="text-sm text-gray-500 mt-1">客户订单统计与 AI 分析</p>
        </div>
        <Link href="/analytics/employees" className="text-sm text-indigo-600 hover:text-indigo-700">
          员工分析 →
        </Link>
      </div>

      {/* 筛选 */}
      <div className="flex gap-3 mb-6">
        <select
          value={selected}
          onChange={e => setSelected(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm flex-1 max-w-xs"
        >
          <option value="">选择客户</option>
          {customers.map(c => (
            <option key={c.name} value={c.name}>{c.name}（{c.orderCount}单）</option>
          ))}
        </select>
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

      {loading && <div className="text-center py-12 text-gray-400">加载中...</div>}

      {!loading && !data && <div className="text-center py-12 text-gray-400">请选择客户查看分析</div>}

      {!loading && data && (
        <div className="space-y-6">
          {/* 概览卡片 */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {[
              { label: '订单数', value: data.orderCount, color: 'text-indigo-600' },
              { label: '总数量', value: `${data.totalQuantity}件`, color: 'text-gray-800' },
              { label: '准时率', value: `${data.onTimeRate}%`, color: data.onTimeRate >= 80 ? 'text-green-600' : 'text-red-600' },
              { label: '平均评分', value: data.avgScore || '—', color: data.avgScore >= 85 ? 'text-green-600' : 'text-amber-600' },
              { label: '不良率', value: `${data.avgDefectRate}%`, color: data.avgDefectRate > 3 ? 'text-red-600' : 'text-green-600' },
            ].map(item => (
              <div key={item.label} className="bg-white rounded-xl border border-gray-200 p-4 text-center">
                <div className={`text-2xl font-bold ${item.color}`}>{item.value}</div>
                <div className="text-xs text-gray-500 mt-1">{item.label}</div>
              </div>
            ))}
          </div>

          {/* AI 分析 */}
          <div className="bg-gradient-to-br from-slate-50 to-white rounded-xl border border-slate-100 p-5">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-lg">🧠</span>
              <span className="text-sm font-semibold text-gray-700">AI 分析</span>
            </div>
            <p className="text-sm text-gray-600 leading-relaxed">{data.aiSummary}</p>
          </div>

          {/* 订单状态分布 */}
          <div className="grid md:grid-cols-2 gap-4">
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">订单状态</h3>
              <div className="space-y-2">
                {[
                  { label: '执行中', value: data.activeCount, color: 'bg-blue-500' },
                  { label: '已完成', value: data.completedCount, color: 'bg-green-500' },
                  { label: '已取消', value: data.cancelledCount, color: 'bg-red-500' },
                ].map(item => (
                  <div key={item.label} className="flex items-center gap-3">
                    <span className="text-xs text-gray-500 w-12">{item.label}</span>
                    <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${item.color}`}
                        style={{ width: `${data.orderCount > 0 ? (item.value / data.orderCount) * 100 : 0}%` }}
                      />
                    </div>
                    <span className="text-xs font-medium text-gray-700 w-6 text-right">{item.value}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">延期原因分布</h3>
              {data.topDelayReasons.length === 0 ? (
                <p className="text-sm text-gray-400">暂无延期记录</p>
              ) : (
                <div className="space-y-2">
                  {data.topDelayReasons.map(r => (
                    <div key={r.reason} className="flex items-center justify-between text-sm">
                      <span className="text-gray-600">{r.reason}</span>
                      <span className="font-medium text-gray-800">{r.count} 次</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* 月度趋势 */}
          {data.monthlyTrend.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">月度趋势</h3>
              <div className="flex items-end gap-2 h-32">
                {data.monthlyTrend.map(m => {
                  const maxOrders = Math.max(...data.monthlyTrend.map(t => t.orders));
                  const h = maxOrders > 0 ? (m.orders / maxOrders) * 100 : 0;
                  return (
                    <div key={m.month} className="flex-1 flex flex-col items-center gap-1">
                      <span className="text-xs font-medium text-indigo-600">{m.orders}</span>
                      <div className="w-full bg-indigo-100 rounded-t-md" style={{ height: `${Math.max(h, 4)}%` }}>
                        <div className="w-full h-full bg-indigo-500 rounded-t-md" />
                      </div>
                      <span className="text-[10px] text-gray-400">{m.month.slice(5)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
