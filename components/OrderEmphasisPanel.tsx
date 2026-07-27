'use client';

import { useEffect, useState } from 'react';
import { getOrderEmphasis, type EmphasisItem } from '@/app/actions/order-emphasis';

/** 客户强调事项:PO/邮件里强调的要求,置顶在节点报告表单上,标来源防漏。空则不渲染。 */
export function OrderEmphasisPanel({ orderId }: { orderId: string }) {
  const [items, setItems] = useState<EmphasisItem[] | null>(null);
  useEffect(() => {
    let alive = true;
    getOrderEmphasis(orderId).then((r) => { if (alive) setItems(r.data || []); });
    return () => { alive = false; };
  }, [orderId]);

  if (!items || items.length === 0) return null;

  return (
    <div className="rounded-xl border-2 border-amber-300 bg-amber-50 p-4 mb-4">
      <div className="text-sm font-semibold text-amber-800 mb-2 flex items-center gap-2">
        📌 客户强调事项 <span className="text-xs font-normal text-amber-600">(来自 PO / 邮件,验收/确认时务必核对)</span>
      </div>
      <ul className="flex flex-col gap-1.5">
        {items.map((it, i) => (
          <li key={i} className="flex items-start gap-2 text-sm text-gray-800">
            <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium ${it.source === 'PO强调' ? 'bg-violet-100 text-violet-700 border border-violet-200' : 'bg-teal-100 text-teal-700 border border-teal-200'}`}>
              {it.source}
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 shrink-0">{it.kind}</span>
            <span className="leading-snug">{it.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
