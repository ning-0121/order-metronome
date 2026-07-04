'use client';

/**
 * 首页「我的采购追踪」板块 —— 业务看自己每个订单的采购进度 + 到期提醒待办。
 * 数据来自 getMyProcurementTracking(按 owner/creator 过滤);无采购活动时整块隐藏。
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getMyProcurementTracking, type MyProcOrderRow } from '@/app/actions/my-procurement-tracking';

export function MyProcurementTrackingCard() {
  const [rows, setRows] = useState<MyProcOrderRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getMyProcurementTracking().then((res) => {
      if ((res as any).data) setRows((res as any).data);
      setLoading(false);
    });
  }, []);

  if (loading) return null;
  if (rows.length === 0) return null;   // 没有采购活动 → 不占版面

  const totalDue = rows.reduce((a, r) => a + r.reminder_due, 0);

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
        <span className="text-sm font-semibold text-gray-700">🛒 我的采购追踪</span>
        <span className="text-xs text-gray-400">我负责订单的采购进度</span>
        {totalDue > 0 && (
          <span className="ml-auto text-xs font-medium px-2 py-0.5 rounded bg-red-100 text-red-700">
            {totalDue} 项提醒到期
          </span>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
              <th className="py-2 px-3 font-medium">订单</th>
              <th className="py-2 px-3 font-medium">客户</th>
              <th className="py-2 px-3 font-medium">采购单</th>
              <th className="py-2 px-3 font-medium">到货进度</th>
              <th className="py-2 px-3 font-medium">提醒待办</th>
              <th className="py-2 px-3 font-medium">工厂期</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const pct = r.total_lines > 0 ? Math.round((r.received_lines / r.total_lines) * 100) : 0;
              return (
                <tr key={r.order_id} className="border-b border-gray-50 hover:bg-gray-50/60">
                  <td className="py-2 px-3">
                    <Link href={`/orders/${r.order_id}`} className="text-indigo-600 hover:underline font-medium">
                      {r.order_no || r.order_id.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="py-2 px-3 text-gray-600">{r.customer_name || '—'}</td>
                  <td className="py-2 px-3 text-gray-600">{r.po_count > 0 ? `${r.po_count} 张` : '—'}</td>
                  <td className="py-2 px-3">
                    {r.total_lines > 0 ? (
                      <div className="flex items-center gap-2 min-w-[120px]">
                        <div className="flex-1 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                          <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="text-xs text-gray-500 shrink-0">{r.received_lines}/{r.total_lines}</span>
                      </div>
                    ) : <span className="text-xs text-gray-400">未起采购</span>}
                  </td>
                  <td className="py-2 px-3">
                    {r.reminder_due > 0 ? (
                      <span className="text-xs font-medium px-2 py-0.5 rounded bg-red-100 text-red-700">{r.reminder_due} 到期</span>
                    ) : r.reminder_open > 0 ? (
                      <span className="text-xs text-gray-500">{r.reminder_open} 项</span>
                    ) : <span className="text-xs text-gray-300">—</span>}
                  </td>
                  <td className="py-2 px-3 text-gray-500 text-xs">{r.factory_date || '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
