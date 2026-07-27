'use client';

import { useRouter, useSearchParams } from 'next/navigation';

/** 订单列表·按建单月(created_at)筛选。下拉选月 → 导航时保留其他筛选参数;选「全部月份」清空。 */
export function OrderMonthFilter({ months, current }: { months: string[]; current: string }) {
  const router = useRouter();
  const sp = useSearchParams();

  const onChange = (v: string) => {
    const p = new URLSearchParams(sp.toString());
    if (v) p.set('created_month', v); else p.delete('created_month');
    router.push(`/orders?${p.toString()}`);
  };

  const label = (m: string) => {
    const [y, mm] = m.split('-');
    return `${y}年${mm}月`;
  };

  return (
    <label className="inline-flex items-center gap-1.5 text-xs text-gray-500">
      建单月
      <select
        value={current}
        onChange={(e) => onChange(e.target.value)}
        className={`rounded-full border px-3 py-1.5 text-xs outline-none cursor-pointer ${current ? 'border-indigo-400 bg-indigo-50 text-indigo-700 font-medium' : 'border-gray-300 text-gray-600'}`}
      >
        <option value="">全部月份</option>
        {months.map((m) => <option key={m} value={m}>{label(m)}</option>)}
      </select>
    </label>
  );
}
