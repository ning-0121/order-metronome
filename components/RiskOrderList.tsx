'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

interface RiskOrder {
  id: string;
  orderNo: string;
  customerName: string;
  factoryName: string;
  quantity: number | null;
  factoryDate: string | null;
  etd: string | null;
  lifecycleStatus: string;
  overdueCount: number;
  blockedCount: number;
  overdueNames: string[];
  blockedNames: string[];
  riskColor: string;
  riskReason: string;
  focusMilestoneId?: string | null;
  focusMilestoneName?: string;
}

export function RiskOrderList({ orders }: { orders: RiskOrder[] }) {
  // 「加入备忘录」按钮与弹窗已随个人备忘功能下线(CEO 2026-08-01:用不上;user_memos 上线至今 0 条)
  const pathname = usePathname();
  const fromParam = encodeURIComponent(pathname);

  if (orders.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-12 text-center text-gray-400">
        ✨ 没有符合条件的订单
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {orders.map(o => {
        const colorClasses: Record<string, string> = {
          RED: 'border-red-300 bg-red-50/30',
          YELLOW: 'border-yellow-300 bg-yellow-50/30',
          GREEN: 'border-green-300 bg-green-50/30',
        };
        return (
          <div
            key={o.id}
            className={`bg-white rounded-xl border-2 p-4 ${colorClasses[o.riskColor] || 'border-gray-200'}`}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                {/* 订单基本信息 */}
                <div className="flex items-center gap-2 mb-2">
                  <span className="font-bold text-gray-900 text-lg">{o.orderNo}</span>
                  <span className="text-sm text-gray-500">·</span>
                  <span className="text-sm text-gray-700">{o.customerName}</span>
                  {o.factoryName !== '—' && (
                    <>
                      <span className="text-sm text-gray-500">·</span>
                      <span className="text-sm text-gray-500">{o.factoryName}</span>
                    </>
                  )}
                </div>

                {/* 订单关键数据 */}
                <div className="flex items-center gap-3 text-xs text-gray-500 mb-2">
                  {o.quantity && <span>📦 {o.quantity}件</span>}
                  {o.factoryDate && <span>🏭 出厂 {o.factoryDate}</span>}
                  {o.etd && <span>🚢 ETD {o.etd}</span>}
                  <span className="px-2 py-0.5 bg-gray-100 rounded">{o.lifecycleStatus}</span>
                </div>

                {/* 风险详情 */}
                {o.overdueCount > 0 && (
                  <div className="mt-2 text-sm">
                    <span className="font-medium text-red-700">🔴 {o.overdueCount} 个逾期节点：</span>
                    <span className="text-gray-600">{o.overdueNames.join('、')}</span>
                    {o.overdueCount > 3 && <span className="text-gray-400"> 等</span>}
                  </div>
                )}
                {o.blockedCount > 0 && (
                  <div className="mt-1 text-sm">
                    <span className="font-medium text-orange-700">🔒 {o.blockedCount} 个阻塞节点：</span>
                    <span className="text-gray-600">{o.blockedNames.join('、')}</span>
                    {o.blockedCount > 3 && <span className="text-gray-400"> 等</span>}
                  </div>
                )}
                {o.riskReason && (
                  <div className="mt-1 text-xs text-gray-500 italic">{o.riskReason}</div>
                )}
              </div>

              {/* 操作按钮 */}
              <div className="flex flex-col gap-2 shrink-0">
                <Link
                  href={
                    o.focusMilestoneId
                      ? `/orders/${o.id}?tab=progress&focus=${o.focusMilestoneId}&from=${fromParam}`
                      : `/orders/${o.id}?from=${fromParam}`
                  }
                  className="inline-flex items-center justify-center gap-1 rounded-lg bg-indigo-600 text-white px-4 py-2 text-sm font-medium hover:bg-indigo-700"
                  title={o.focusMilestoneName ? `直接定位到「${o.focusMilestoneName}」` : ''}
                >
                  📋 处理
                </Link>
              </div>
            </div>
          </div>
        );
      })}

    </div>
  );
}

