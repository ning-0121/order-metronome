'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';
import Link from 'next/link';

interface FactoryStats {
  name: string;
  orderCount: number;
  totalQty: number;
  activeCount: number;
  completedCount: number;
  onTimeCount: number;
  onTimeRate: number;
  avgDelayDays: number;
  categories: string[];
  workerCount: number | null;
  monthlyCapacity: number | null;
}

export default function FactoryAnalyticsPage() {
  const [factories, setFactories] = useState<FactoryStats[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();
    (async () => {
      const [ordersRes, milestonesRes, factoriesRes] = await Promise.all([
        (supabase.from('orders') as any).select('id, factory_name, factory_id, quantity, lifecycle_status, factory_date'),
        (supabase.from('milestones') as any).select('order_id, status, due_at, completed_at').eq('step_key', 'factory_completion'),
        (supabase.from('factories') as any).select('factory_name, product_categories, worker_count, monthly_capacity').is('deleted_at', null),
      ]);

      const orders = ordersRes.data || [];
      const completionMilestones = milestonesRes.data || [];
      const factoryInfo = factoriesRes.data || [];

      // 工厂信息映射
      const infoMap = new Map<string, any>();
      for (const f of factoryInfo) infoMap.set(f.factory_name, f);

      // 工厂完成里程碑映射
      const completionMap = new Map<string, any>();
      for (const m of completionMilestones) completionMap.set(m.order_id, m);

      // 按工厂聚合
      const map: Record<string, FactoryStats> = {};
      for (const o of orders) {
        const fn = o.factory_name || '未指定工厂';
        if (!map[fn]) {
          const info = infoMap.get(fn);
          map[fn] = {
            name: fn, orderCount: 0, totalQty: 0, activeCount: 0, completedCount: 0,
            onTimeCount: 0, onTimeRate: 0, avgDelayDays: 0,
            categories: info?.product_categories || [],
            workerCount: info?.worker_count || null,
            monthlyCapacity: info?.monthly_capacity || null,
          };
        }
        const s = map[fn];
        s.orderCount++;
        s.totalQty += o.quantity || 0;

        const ls = o.lifecycle_status || '';
        const isDone = ls === '已完成' || ls === 'completed' || ls === '已复盘';
        if (isDone) {
          s.completedCount++;
          // 准时率：工厂完成日期 vs 出厂日期
          const cm = completionMap.get(o.id);
          if (cm?.completed_at && o.factory_date) {
            if (new Date(cm.completed_at) <= new Date(o.factory_date + 'T23:59:59')) {
              s.onTimeCount++;
            }
          }
        } else if (!['cancelled', '已取消'].includes(ls)) {
          s.activeCount++;
        }
      }

      // 计算准时率
      const result = Object.values(map).map(s => ({
        ...s,
        onTimeRate: s.completedCount > 0 ? Math.round((s.onTimeCount / s.completedCount) * 100) : 0,
      })).sort((a, b) => b.orderCount - a.orderCount);

      setFactories(result);
      setLoading(false);
    })();
  }, []);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link href="/analytics" className="text-sm text-gray-500 hover:text-indigo-600">← 数据分析</Link>
        <h1 className="text-2xl font-bold text-gray-900 mt-2">🏭 工厂绩效分析</h1>
        <p className="text-sm text-gray-500 mt-1">订单量、准时率、产能、品类概览</p>
      </div>

      {loading && <div className="text-center py-12 text-gray-400">加载中...</div>}

      {!loading && (
        <div className="space-y-4">
          {factories.map((f, i) => (
            <div key={f.name} className="bg-white rounded-xl border border-gray-200 p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <span className="text-lg font-bold text-gray-400 w-6">{i + 1}</span>
                  <div>
                    <h3 className="font-bold text-gray-900 text-lg">{f.name}</h3>
                    {f.categories.length > 0 && (
                      <div className="flex gap-1 mt-1 flex-wrap">
                        {f.categories.map((c: string) => (
                          <span key={c} className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{c}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                {f.workerCount && (
                  <div className="text-right text-sm text-gray-500">
                    {f.workerCount} 人 · 月产能 {f.monthlyCapacity?.toLocaleString() || '?'} 件
                  </div>
                )}
              </div>

              <div className="grid grid-cols-3 md:grid-cols-6 gap-3 text-center">
                <div className="bg-gray-50 rounded-lg p-2">
                  <div className="text-xl font-bold text-gray-900">{f.orderCount}</div>
                  <div className="text-xs text-gray-500">总订单</div>
                </div>
                <div className="bg-gray-50 rounded-lg p-2">
                  <div className="text-xl font-bold text-gray-900">{f.totalQty.toLocaleString()}</div>
                  <div className="text-xs text-gray-500">总件数</div>
                </div>
                <div className="bg-blue-50 rounded-lg p-2">
                  <div className="text-xl font-bold text-blue-700">{f.activeCount}</div>
                  <div className="text-xs text-gray-500">执行中</div>
                </div>
                <div className="bg-green-50 rounded-lg p-2">
                  <div className="text-xl font-bold text-green-700">{f.completedCount}</div>
                  <div className="text-xs text-gray-500">已完成</div>
                </div>
                <div className={`rounded-lg p-2 ${f.onTimeRate >= 80 ? 'bg-green-50' : f.onTimeRate >= 50 ? 'bg-amber-50' : 'bg-red-50'}`}>
                  <div className={`text-xl font-bold ${f.onTimeRate >= 80 ? 'text-green-700' : f.onTimeRate >= 50 ? 'text-amber-700' : 'text-red-700'}`}>
                    {f.completedCount > 0 ? `${f.onTimeRate}%` : '-'}
                  </div>
                  <div className="text-xs text-gray-500">准时率</div>
                </div>
                <div className="bg-gray-50 rounded-lg p-2">
                  <div className="text-xl font-bold text-gray-700">{f.onTimeCount}/{f.completedCount}</div>
                  <div className="text-xs text-gray-500">准时/完成</div>
                </div>
              </div>

              {/* 产能利用率（如果有月产能数据） */}
              {f.monthlyCapacity && f.activeCount > 0 && (
                <div className="mt-3 pt-3 border-t border-gray-100">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-gray-500">当前在手订单量占月产能</span>
                    {(() => {
                      const activeQty = Math.round(f.totalQty * (f.activeCount / Math.max(f.orderCount, 1)));
                      const utilRate = Math.round((activeQty / f.monthlyCapacity) * 100);
                      return (
                        <span className={`font-medium ${utilRate > 100 ? 'text-red-600' : utilRate > 80 ? 'text-amber-600' : 'text-green-600'}`}>
                          {utilRate}%（约 {activeQty.toLocaleString()} 件）
                        </span>
                      );
                    })()}
                  </div>
                </div>
              )}
            </div>
          ))}
          {factories.length === 0 && <div className="text-center py-12 text-gray-400">暂无数据</div>}
        </div>
      )}
    </div>
  );
}
