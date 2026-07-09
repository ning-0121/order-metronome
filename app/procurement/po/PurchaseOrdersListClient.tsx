'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';

const STATUS_CN: Record<string, string> = {
  draft: '草稿/待下单', placed: '已下单', confirmed: '已确认',
  receiving: '收货中', received: '已收货', closed: '已关闭', cancelled: '已取消',
};
const STATUS_CLASS: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-600', placed: 'bg-indigo-100 text-indigo-700',
  confirmed: 'bg-sky-100 text-sky-700', receiving: 'bg-amber-100 text-amber-700',
  received: 'bg-emerald-100 text-emerald-700', closed: 'bg-gray-100 text-gray-500',
  cancelled: 'bg-rose-100 text-rose-600',
};

type PO = {
  id: string; po_no: string | null; supplier_name: string | null;
  status: string | null; approval_status: string | null;
  total_amount: number | null; currency: string; price_tbd: boolean;
  delivery_date: string | null; created_at: string | null;
  orders: { order_no: string | null; internal_order_no: string | null; customer_name: string | null }[];
};

export function PurchaseOrdersListClient({ pos }: { pos: PO[] }) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<string>('all');

  const statuses = useMemo(() => {
    const s = new Set<string>();
    for (const p of pos) if (p.status) s.add(p.status);
    return ['all', ...Array.from(s)];
  }, [pos]);

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return pos.filter((p) => {
      if (status !== 'all' && p.status !== status) return false;
      if (!kw) return true;
      const hay = [
        p.po_no, p.supplier_name,
        ...p.orders.flatMap((o) => [o.order_no, o.internal_order_no, o.customer_name]),
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(kw);
    });
  }, [pos, q, status]);

  const fmtDate = (v: string | null) => (v ? String(v).slice(0, 10) : '—');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="搜索 采购单号 / 订单号 / 供应商 / 客户…"
          className="flex-1 min-w-[220px] rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        <div className="flex flex-wrap gap-1.5">
          {statuses.map((s) => (
            <button key={s} onClick={() => setStatus(s)}
              className={`text-xs px-2.5 py-1 rounded-lg border ${status === s ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-600 border-gray-200 hover:border-indigo-300'}`}>
              {s === 'all' ? '全部' : (STATUS_CN[s] || s)}
            </button>
          ))}
        </div>
      </div>

      <div className="text-xs text-gray-400">{filtered.length} / {pos.length} 张采购单</div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {filtered.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-400">没有匹配的采购单</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="bg-gray-50 text-left text-gray-500 text-xs">
                <th className="px-3 py-2">采购单号</th>
                <th className="px-3 py-2">供应商</th>
                <th className="px-3 py-2">关联订单</th>
                <th className="px-3 py-2">状态</th>
                <th className="px-3 py-2 text-right">合计</th>
                <th className="px-3 py-2">交期</th>
                <th className="px-3 py-2">创建</th>
              </tr></thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map((p) => (
                  <tr key={p.id} className="hover:bg-indigo-50/40">
                    <td className="px-3 py-2 whitespace-nowrap">
                      <Link href={`/procurement/po/${p.id}`} className="font-semibold text-indigo-600 hover:underline">{p.po_no || '—'}</Link>
                    </td>
                    <td className="px-3 py-2 text-gray-700">{p.supplier_name || '—'}</td>
                    <td className="px-3 py-2 text-gray-500 max-w-[220px] truncate"
                      title={p.orders.map((o) => o.internal_order_no || o.order_no).filter(Boolean).join(' / ')}>
                      {p.orders.map((o) => o.internal_order_no || o.order_no).filter(Boolean).join(' / ') || '—'}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_CLASS[p.status || ''] || 'bg-gray-100 text-gray-500'}`}>
                        {STATUS_CN[p.status || ''] || p.status || '—'}
                      </span>
                      {p.price_tbd && <span className="ml-1 text-[11px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-700">价格待定</span>}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap font-medium text-gray-800">
                      {p.total_amount != null ? `${p.currency} ${p.total_amount}` : '—'}
                    </td>
                    <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{fmtDate(p.delivery_date)}</td>
                    <td className="px-3 py-2 text-gray-400 whitespace-nowrap">{fmtDate(p.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
