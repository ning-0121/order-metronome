'use client';

import { useEffect, useState } from 'react';
import { getCustomerMemoryByCustomer } from '@/app/actions/customer-memory';
import { CATEGORY_LABELS } from '@/lib/domain/customer-memory';

/**
 * 建单时的「客户经验提醒」—— 选中客户后自动拉取该客户的备忘并显示。
 * Phase 1：只读提醒，不做自动审核。数据源 = customer_memory（按 customer_name 关联）。
 */
export function CustomerMemoReminder({ customerName }: { customerName: string | null }) {
  const [memos, setMemos] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!customerName) { setMemos([]); return; }
    let cancelled = false;
    setLoading(true);
    getCustomerMemoryByCustomer(customerName)
      .then(({ data }) => { if (!cancelled) setMemos(data || []); })
      .catch(() => { if (!cancelled) setMemos([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [customerName]);

  if (!customerName || loading || memos.length === 0) return null;

  // 高风险置顶
  const sorted = [...memos].sort((a, b) =>
    (b.risk_level === 'high' ? 1 : 0) - (a.risk_level === 'high' ? 1 : 0),
  );

  return (
    <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
      <p className="text-xs font-semibold text-amber-800 mb-1.5">
        📋 该客户经验提醒（{memos.length} 条）—— 建单前请核对
      </p>
      <div className="space-y-1 max-h-40 overflow-y-auto">
        {sorted.slice(0, 8).map((m: any, i: number) => (
          <div
            key={m.id || i}
            className={`text-xs px-2 py-1 rounded ${
              m.risk_level === 'high' ? 'bg-red-100 text-red-700 font-medium' : 'bg-white text-gray-600'
            }`}
          >
            {m.risk_level === 'high' ? '⚠️ ' : ''}
            <span className="opacity-60">[{(CATEGORY_LABELS as Record<string, string>)[m.category] || m.category}]</span>{' '}
            {m.content}
          </div>
        ))}
      </div>
      <p className="mt-1.5 text-[10px] text-amber-600">
        注意：此提示来自客户备忘，仅作风险提醒，不阻止建单。
      </p>
    </div>
  );
}
