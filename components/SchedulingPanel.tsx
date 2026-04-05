'use client';

import { useState, useEffect } from 'react';
import { getSchedulingAdvice } from '@/app/actions/scheduling';

const STATUS_COLORS = {
  overload: 'bg-red-100 text-red-700',
  normal: 'bg-green-100 text-green-700',
  underload: 'bg-amber-100 text-amber-700',
  empty: 'bg-gray-100 text-gray-500',
};

export function SchedulingPanel() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getSchedulingAdvice().then(res => { setData(res.data); setLoading(false); });
  }, []);

  if (loading) return <div className="text-center py-8 text-gray-400 text-sm">分析排单数据...</div>;
  if (!data) return null;

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6 space-y-5">
      <div>
        <h2 className="text-lg font-bold text-gray-900">🗓 智能排单建议</h2>
        <p className="text-sm text-indigo-600 mt-1">{data.overallAdvice}</p>
      </div>

      {/* 工厂负荷 */}
      {data.factoryLoad.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-700 mb-2">🏭 工厂产能负荷</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {data.factoryLoad.map((f: any) => (
              <div key={f.factory} className="p-3 bg-gray-50 rounded-lg">
                <div className="font-medium text-gray-900 text-sm">{f.factory}</div>
                <div className={`text-xl font-bold mt-1 ${f.utilization > 100 ? 'text-red-600' : f.utilization > 80 ? 'text-amber-600' : 'text-green-600'}`}>
                  {f.utilization}%
                </div>
                <div className="text-xs text-gray-500">{f.activeQty.toLocaleString()}/{f.capacity.toLocaleString()}件</div>
                <div className="text-xs text-gray-400 mt-1">{f.advice}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 月度空档 */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 mb-2">📅 未来6个月订单分布</h3>
        <div className="flex gap-2">
          {data.monthlyGaps.map((m: any) => (
            <div key={m.month} className="flex-1 text-center p-2 rounded-lg bg-gray-50">
              <div className="text-sm font-medium text-gray-900">{m.month}</div>
              <div className={`text-xs px-2 py-0.5 rounded-full inline-block mt-1 ${STATUS_COLORS[m.status as keyof typeof STATUS_COLORS]}`}>
                {m.status === 'overload' ? '偏多' : m.status === 'underload' ? '偏少' : m.status === 'empty' ? '空档' : '正常'}
              </div>
              <div className="text-xs text-gray-400 mt-1">{m.orderCount}单/{m.totalQty.toLocaleString()}件</div>
            </div>
          ))}
        </div>
      </div>

      {/* 紧急订单 */}
      {data.priorityOrders.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-700 mb-2">⚡ 紧急订单（14天内到期）</h3>
          <div className="space-y-1">
            {data.priorityOrders.map((o: any) => (
              <div key={o.orderNo} className="flex items-center justify-between text-sm px-3 py-2 bg-gray-50 rounded-lg">
                <span><span className="font-medium text-gray-900">{o.orderNo}</span> <span className="text-gray-500">{o.customer}</span></span>
                <span className={`text-xs font-medium ${o.daysLeft < 0 ? 'text-red-600' : o.daysLeft <= 7 ? 'text-amber-600' : 'text-gray-500'}`}>
                  {o.daysLeft < 0 ? `超期${Math.abs(o.daysLeft)}天` : `${o.daysLeft}天`} · {o.risk}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
