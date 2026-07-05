'use client';

/** 财务资金进度时间线:读财务系统回传的 结算/收款/付款 事件(order_finance_events)。仅 CAN_SEE_FINANCIALS 挂载。 */

import { useEffect, useState } from 'react';
import { getOrderFinanceEvents, type OrderFinanceEvent } from '@/app/actions/order-financials';

const META: Record<string, { label: string; icon: string; tone: string }> = {
  'settlement.closed': { label: '结算关闭', icon: '🧾', tone: 'text-gray-700' },
  'collection.received': { label: '收款到账', icon: '💰', tone: 'text-emerald-700' },
  'payment.completed': { label: '付款完成', icon: '💸', tone: 'text-sky-700' },
};

export function FinanceEventsTimeline({ orderId }: { orderId: string }) {
  const [events, setEvents] = useState<OrderFinanceEvent[] | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    getOrderFinanceEvents(orderId).then((r) => {
      if (r.error) setErr(r.error);
      else setEvents(r.data || []);
    }).catch(() => setErr('加载失败'));
  }, [orderId]);

  if (err) return null;               // 无权/失败:静默不显示(不打扰)
  if (events === null) return null;   // 加载中不占位
  if (events.length === 0) return null; // 财务还没回传任何资金事件 → 不显示空板

  const fmt = (n: number | null, c: string | null) => (n == null ? '—' : `${c === 'USD' ? '$' : '¥'}${Number(n).toLocaleString()}`);

  return (
    <div className="mt-4 rounded-xl border border-gray-200 bg-white p-4">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-sm font-bold text-gray-900">资金进度</h3>
        <span className="text-xs text-gray-400">来自财务系统</span>
      </div>
      <ol className="space-y-2.5">
        {events.map((e) => {
          const m = META[e.event_type] || { label: e.event_type, icon: '•', tone: 'text-gray-600' };
          return (
            <li key={e.id} className="flex items-start gap-3 text-sm">
              <span className="mt-0.5 text-base leading-none">{m.icon}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className={`font-medium ${m.tone}`}>{m.label}</span>
                  <span className="tabular-nums text-gray-900">{fmt(e.amount, e.currency)}</span>
                </div>
                <div className="text-xs text-gray-400">
                  {e.occurred_at ? String(e.occurred_at).slice(0, 16).replace('T', ' ') : ''}
                  {e.note ? ` · ${e.note}` : ''}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
