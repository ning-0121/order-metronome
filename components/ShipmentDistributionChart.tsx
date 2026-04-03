'use client';

import { useState } from 'react';
import type { MonthlyShipment, CapacityAnalysis } from '@/app/actions/analytics';

interface Props {
  distribution: MonthlyShipment[];
  aiAnalysis: CapacityAnalysis | null;
  currentMonth: string;
}

const STATUS_CONFIG = {
  overload: { label: '超负荷', color: 'bg-red-500', textColor: 'text-red-700', bgColor: 'bg-red-50', border: 'border-red-200' },
  normal: { label: '正常', color: 'bg-green-500', textColor: 'text-green-700', bgColor: 'bg-green-50', border: 'border-green-200' },
  underload: { label: '偏空', color: 'bg-yellow-500', textColor: 'text-yellow-700', bgColor: 'bg-yellow-50', border: 'border-yellow-200' },
  empty: { label: '空档', color: 'bg-gray-400', textColor: 'text-gray-600', bgColor: 'bg-gray-50', border: 'border-gray-200' },
};

type ViewMode = 'shipment' | 'timeline';

export function ShipmentDistributionChart({ distribution, aiAnalysis, currentMonth }: Props) {
  const [expandedMonth, setExpandedMonth] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('shipment');

  const maxQty = Math.max(...distribution.map(m => m.totalQuantity), 1);
  const maxCount = Math.max(...distribution.map(m => Math.max(m.orderDateCount, m.productionCount, m.factoryDateCount)), 1);

  function getMonthStatus(month: string) {
    if (!aiAnalysis) return null;
    return aiAnalysis.monthlyInsights.find(i => i.month === month);
  }

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        {/* 标题 + 视图切换 */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold text-gray-900">📦 月度排产分布</h2>
            <p className="text-xs text-gray-500 mt-1">当月 + 未来8个月 · 点击月份查看明细</p>
          </div>
          <div className="flex bg-gray-100 rounded-lg p-0.5">
            <button onClick={() => setViewMode('shipment')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${viewMode === 'shipment' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>
              出货量
            </button>
            <button onClick={() => setViewMode('timeline')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${viewMode === 'timeline' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>
              三日期
            </button>
          </div>
        </div>

        {/* 图例 */}
        <div className="flex items-center gap-4 text-xs text-gray-500 mb-2">
          {viewMode === 'shipment' ? (
            <>
              <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-green-500 inline-block" /> 已完成</span>
              <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-blue-500 inline-block" /> 计划中</span>
            </>
          ) : (
            <>
              <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-indigo-500 inline-block" /> 下单</span>
              <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-amber-500 inline-block" /> 生产上线</span>
              <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-emerald-500 inline-block" /> 出厂</span>
            </>
          )}
        </div>

        {/* 条形图 */}
        <div className="flex items-end gap-1.5 mt-4">
          {distribution.map(m => {
            const isCurrent = m.month === currentMonth;
            const insight = getMonthStatus(m.month);
            const statusCfg = insight ? STATUS_CONFIG[insight.status] : null;

            if (viewMode === 'shipment') {
              // 出货量模式
              const height = maxQty > 0 ? (m.totalQuantity / maxQty) * 100 : 0;
              const completedH = m.orderCount > 0 ? (m.completedCount / m.orderCount) * height : 0;
              const plannedH = height - completedH;
              return (
                <div key={m.month} className="flex-1 flex flex-col items-center cursor-pointer group"
                  onClick={() => setExpandedMonth(expandedMonth === m.month ? null : m.month)}>
                  <div className="text-xs font-medium text-gray-700 mb-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    {m.totalQuantity > 0 ? m.totalQuantity.toLocaleString() : ''}
                  </div>
                  <div className="w-full flex flex-col justify-end" style={{ height: '160px' }}>
                    {plannedH > 0 && <div className="w-full bg-blue-500 rounded-t-sm group-hover:bg-blue-600" style={{ height: `${plannedH}%` }} />}
                    {completedH > 0 && <div className={`w-full bg-green-500 group-hover:bg-green-600 ${plannedH === 0 ? 'rounded-t-sm' : ''}`} style={{ height: `${completedH}%` }} />}
                    {height === 0 && <div className="w-full bg-gray-200 rounded-t-sm" style={{ height: '2px' }} />}
                  </div>
                  <div className={`mt-2 text-xs text-center ${isCurrent ? 'font-bold text-indigo-700' : 'text-gray-600'}`}>{m.label}</div>
                  <div className="text-xs text-gray-400">{m.orderCount > 0 ? `${m.orderCount}单` : '-'}</div>
                  {statusCfg && <div className={`w-2 h-2 rounded-full mt-1 ${statusCfg.color}`} title={statusCfg.label} />}
                </div>
              );
            } else {
              // 三日期模式：三根并列条
              const h1 = maxCount > 0 ? (m.orderDateCount / maxCount) * 100 : 0;
              const h2 = maxCount > 0 ? (m.productionCount / maxCount) * 100 : 0;
              const h3 = maxCount > 0 ? (m.factoryDateCount / maxCount) * 100 : 0;
              return (
                <div key={m.month} className="flex-1 flex flex-col items-center cursor-pointer group"
                  onClick={() => setExpandedMonth(expandedMonth === m.month ? null : m.month)}>
                  <div className="w-full flex items-end justify-center gap-0.5" style={{ height: '160px' }}>
                    <div className="w-1/4 bg-indigo-500 rounded-t-sm group-hover:bg-indigo-600 transition-all" style={{ height: `${Math.max(h1, 2)}%` }} title={`下单 ${m.orderDateCount}`} />
                    <div className="w-1/4 bg-amber-500 rounded-t-sm group-hover:bg-amber-600 transition-all" style={{ height: `${Math.max(h2, 2)}%` }} title={`上线 ${m.productionCount}`} />
                    <div className="w-1/4 bg-emerald-500 rounded-t-sm group-hover:bg-emerald-600 transition-all" style={{ height: `${Math.max(h3, 2)}%` }} title={`出厂 ${m.factoryDateCount}`} />
                  </div>
                  <div className={`mt-2 text-xs text-center ${isCurrent ? 'font-bold text-indigo-700' : 'text-gray-600'}`}>{m.label}</div>
                  <div className="text-xs text-gray-400">{m.orderCount > 0 ? `${m.orderCount}单` : '-'}</div>
                  {statusCfg && <div className={`w-2 h-2 rounded-full mt-1 ${statusCfg.color}`} title={statusCfg.label} />}
                </div>
              );
            }
          })}
        </div>

        {/* 展开月份明细 */}
        {expandedMonth && (() => {
          const m = distribution.find(d => d.month === expandedMonth);
          if (!m) return null;
          const insight = getMonthStatus(expandedMonth);
          return (
            <div className="mt-4 p-4 bg-gray-50 rounded-xl border border-gray-200">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-bold text-gray-900">{m.month} · {m.label}</h3>
                <button onClick={() => setExpandedMonth(null)} className="text-xs text-gray-400 hover:text-gray-600">关闭</button>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm mb-3">
                <div><span className="text-gray-500">出厂订单：</span><span className="font-medium">{m.orderCount}</span></div>
                <div><span className="text-gray-500">总件数：</span><span className="font-medium">{m.totalQuantity.toLocaleString()}</span></div>
                <div><span className="text-gray-500">已完成：</span><span className="font-medium text-green-700">{m.completedCount}</span></div>
                <div><span className="text-gray-500">计划中：</span><span className="font-medium text-blue-700">{m.plannedCount}</span></div>
              </div>
              {/* 三日期维度 */}
              <div className="grid grid-cols-3 gap-2 mb-3">
                <div className="text-center p-2 bg-indigo-50 rounded-lg">
                  <div className="text-lg font-bold text-indigo-700">{m.orderDateCount}</div>
                  <div className="text-xs text-indigo-500">下单</div>
                </div>
                <div className="text-center p-2 bg-amber-50 rounded-lg">
                  <div className="text-lg font-bold text-amber-700">{m.productionCount}</div>
                  <div className="text-xs text-amber-500">生产上线</div>
                </div>
                <div className="text-center p-2 bg-emerald-50 rounded-lg">
                  <div className="text-lg font-bold text-emerald-700">{m.factoryDateCount}</div>
                  <div className="text-xs text-emerald-500">出厂</div>
                </div>
              </div>
              {m.customers.length > 0 && <div className="text-sm"><span className="text-gray-500">客户：</span>{m.customers.join('、')}</div>}
              {m.factories.length > 0 && <div className="mt-1 text-sm"><span className="text-gray-500">工厂：</span>{m.factories.join('、')}</div>}
              {insight && (
                <div className={`mt-2 text-sm px-3 py-1.5 rounded-lg ${STATUS_CONFIG[insight.status].bgColor} ${STATUS_CONFIG[insight.status].textColor}`}>
                  {insight.advice}
                </div>
              )}
            </div>
          );
        })()}
      </div>

      {/* ===== AI 产能分析面板 ===== */}
      {aiAnalysis && (
        <div className="bg-white rounded-2xl border border-purple-200 p-6">
          <div className="flex items-center gap-2 mb-4">
            <span className="text-xl">🤖</span>
            <h2 className="text-lg font-bold text-gray-900">AI 产能分析 & 排单建议</h2>
          </div>
          <div className="p-4 bg-purple-50 rounded-xl border border-purple-100 mb-4">
            <p className="text-sm text-purple-900 leading-relaxed">{aiAnalysis.summary}</p>
          </div>
          <div className="flex gap-1.5 mb-4 flex-wrap">
            {aiAnalysis.monthlyInsights.map(i => {
              const cfg = STATUS_CONFIG[i.status];
              return (
                <div key={i.month} className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border ${cfg.bgColor} ${cfg.textColor} ${cfg.border}`} title={i.advice}>
                  {i.label} · {cfg.label}
                </div>
              );
            })}
          </div>
          {aiAnalysis.recommendations.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-2">行动建议</h3>
              <div className="space-y-2">
                {aiAnalysis.recommendations.map((r, i) => (
                  <div key={i} className="flex items-start gap-2 text-sm text-gray-700">
                    <span className="text-purple-500 font-bold mt-0.5">{i + 1}.</span>
                    <span>{r}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
