'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';
import Link from 'next/link';

export default function FactoryAnalyticsPage() {
  const [factories, setFactories] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();
    (async () => {
      const { data: orders } = await (supabase.from('orders') as any)
        .select('id, factory_name, quantity, lifecycle_status, created_at');

      if (!orders) { setLoading(false); return; }

      // 按工厂聚合
      const map: Record<string, { name: string; orderCount: number; totalQty: number; activeCount: number; completedCount: number }> = {};
      for (const o of orders) {
        const fn = o.factory_name || '未指定工厂';
        if (!map[fn]) map[fn] = { name: fn, orderCount: 0, totalQty: 0, activeCount: 0, completedCount: 0 };
        map[fn].orderCount++;
        map[fn].totalQty += o.quantity || 0;
        if (o.lifecycle_status === 'completed' || o.lifecycle_status === '已完成') map[fn].completedCount++;
        else if (!['cancelled', '已取消'].includes(o.lifecycle_status || '')) map[fn].activeCount++;
      }

      setFactories(Object.values(map).sort((a, b) => b.orderCount - a.orderCount));
      setLoading(false);
    })();
  }, []);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">🏭 工厂分析</h1>
          <p className="text-sm text-gray-500 mt-1">各工厂订单量、产能、品质概览</p>
        </div>
        <div className="flex gap-3">
          <Link href="/analytics/customers" className="text-sm text-indigo-600 hover:text-indigo-700">客户分析 →</Link>
          <Link href="/analytics/employees" className="text-sm text-indigo-600 hover:text-indigo-700">员工分析 →</Link>
        </div>
      </div>

      {loading && <div className="text-center py-12 text-gray-400">加载中...</div>}

      {!loading && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-left">
                <th className="px-5 py-2.5 font-medium text-gray-600 w-8">#</th>
                <th className="px-5 py-2.5 font-medium text-gray-600">工厂名称</th>
                <th className="px-5 py-2.5 font-medium text-gray-600 text-center">总订单</th>
                <th className="px-5 py-2.5 font-medium text-gray-600 text-center">总数量</th>
                <th className="px-5 py-2.5 font-medium text-gray-600 text-center">执行中</th>
                <th className="px-5 py-2.5 font-medium text-gray-600 text-center">已完成</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {factories.map((f, i) => (
                <tr key={f.name} className="hover:bg-gray-50">
                  <td className="px-5 py-3 text-gray-400">{i + 1}</td>
                  <td className="px-5 py-3 font-semibold text-gray-900">{f.name}</td>
                  <td className="px-5 py-3 text-center text-gray-700">{f.orderCount}</td>
                  <td className="px-5 py-3 text-center text-gray-700">{f.totalQty.toLocaleString()}件</td>
                  <td className="px-5 py-3 text-center text-blue-600 font-medium">{f.activeCount}</td>
                  <td className="px-5 py-3 text-center text-green-600">{f.completedCount}</td>
                </tr>
              ))}
              {factories.length === 0 && (
                <tr><td colSpan={6} className="px-5 py-8 text-center text-gray-400">暂无数据</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
