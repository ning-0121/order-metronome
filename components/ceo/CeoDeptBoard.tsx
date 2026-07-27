'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { CeoCockpit } from '@/lib/services/ceo-cockpit.service';

/** B 区五部门卡片:点「逾期 N」展开该部门逾期订单清单,每单可点进订单页(2026-07-27 CEO:数字要能点开看详情)。 */
export function CeoDeptBoard({ depts }: { depts: CeoCockpit['B'] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-5">
      {depts.map((d) => {
        const expanded = open === d.key;
        return (
          <div key={d.key} className={`rounded-xl border p-3 ${expanded ? 'border-indigo-300 bg-white sm:col-span-5' : 'border-gray-100 bg-gray-50/50'}`}>
            <div className="flex items-center justify-between">
              <div className="flex items-baseline gap-2">
                <span className="text-xs font-semibold text-gray-700">{d.label}</span>
                <span className="text-lg font-bold text-gray-800">{d.active}</span>
                <span className="text-[10px] text-gray-400">在办</span>
              </div>
              <Link href={d.href} className="text-[10px] text-indigo-500 hover:underline">中心 ›</Link>
            </div>
            <div className="mt-1 flex gap-2 text-[11px]">
              {d.overdue > 0 ? (
                <button onClick={() => setOpen(expanded ? null : d.key)} className="font-medium text-rose-600 hover:underline">逾期 {d.overdue} {expanded ? '▲' : '▼'}</button>
              ) : <span className="text-emerald-600">无逾期</span>}
              {d.blocked > 0 && <span className="text-amber-600">卡住 {d.blocked}</span>}
            </div>
            {expanded && (
              <div className="mt-2 max-h-72 overflow-y-auto rounded-lg border border-gray-100 bg-gray-50/60">
                {d.overdueOrders.length === 0 ? <p className="p-3 text-xs text-gray-400">无逾期订单明细</p> : (
                  <table className="w-full text-xs">
                    <thead><tr className="text-left text-gray-400"><th className="px-3 py-1.5">订单</th><th className="px-3">逾期节点</th><th className="px-3 text-right">逾期天数</th><th className="px-3"></th></tr></thead>
                    <tbody className="divide-y divide-gray-100">
                      {d.overdueOrders.map((o) => (
                        <tr key={o.orderId} className="hover:bg-white">
                          <td className="px-3 py-1.5 font-medium text-gray-800">{o.orderNo}</td>
                          <td className="px-3 text-gray-600">{o.node || '—'}</td>
                          <td className={`px-3 text-right tabular-nums ${(o.days || 0) >= 14 ? 'font-semibold text-rose-600' : 'text-amber-600'}`}>{o.days ?? 0} 天</td>
                          <td className="px-3 text-right"><Link href={`/orders/${o.orderId}`} className="text-indigo-600 hover:underline whitespace-nowrap">详情 ›</Link></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
