'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { GoodsReceiptRow } from '@/app/actions/goods-receipts-ledger';

const INSPECT_CN: Record<string, { label: string; cls: string }> = {
  pending: { label: '待检', cls: 'bg-gray-100 text-gray-600' },
  pass: { label: '合格', cls: 'bg-emerald-100 text-emerald-700' },
  concession: { label: '让步接收', cls: 'bg-amber-100 text-amber-700' },
  reject: { label: '拒收', cls: 'bg-rose-100 text-rose-700' },
};
const RETURN_CN: Record<string, string> = { pending: '待退', returned: '已退', replaced: '已换', waived: '免退' };

/**
 * 收货记录台账(2026-07-11 老板):调出所有收货数据,按 供应商 / 日期 / 物料名 筛。
 * 数据服务端一次取回(近 2000 条),筛选纯前端即时生效。
 */
export function GoodsReceiptsPanel({ rows }: { rows: GoodsReceiptRow[] }) {
  const [supplier, setSupplier] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [q, setQ] = useState('');

  const suppliers = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) if (r.supplier_name) s.add(r.supplier_name);
    return [...s].sort((a, b) => a.localeCompare(b, 'zh'));
  }, [rows]);

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (supplier !== 'all' && (r.supplier_name || '(未填供应商)') !== supplier) return false;
      const d = r.received_at ? String(r.received_at).slice(0, 10) : '';
      if (dateFrom && (!d || d < dateFrom)) return false;
      if (dateTo && (!d || d > dateTo)) return false;
      if (kw) {
        const hay = [r.material_name, r.specification, r.color, r.po_no, r.order_label, r.supplier_name]
          .filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
  }, [rows, supplier, dateFrom, dateTo, q]);

  // 合计:按单位分别求和(米/个/kg 混加没有意义)
  const totals = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of filtered) {
      const u = r.unit || '—';
      m.set(u, (m.get(u) || 0) + r.received_qty);
    }
    return [...m.entries()].map(([u, n]) => `${Math.round(n * 1000) / 1000}${u === '—' ? '' : u}`).join(' + ');
  }, [filtered]);

  const fmtD = (v: string | null) => (v ? String(v).slice(0, 10) : '—');

  return (
    <div className="mt-8">
      <div className="flex items-baseline gap-2 mb-3">
        <h2 className="text-lg font-bold text-gray-900">📥 收货记录</h2>
        <span className="text-xs text-gray-400">全部收货流水,按供应商 / 日期 / 物料名调取(近 2000 条)</span>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <select value={supplier} onChange={(e) => setSupplier(e.target.value)}
          className="rounded-lg border border-gray-300 px-2.5 py-2 text-sm bg-white">
          <option value="all">全部供应商</option>
          {suppliers.map((s) => <option key={s} value={s}>{s}</option>)}
          <option value="(未填供应商)">(未填供应商)</option>
        </select>
        <div className="flex items-center gap-1 text-sm text-gray-500">
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
            className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
          <span>~</span>
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
            className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="搜物料名 / 规格 / 颜色 / 采购单号 / 订单号…"
          className="flex-1 min-w-[220px] rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        {(supplier !== 'all' || dateFrom || dateTo || q) && (
          <button onClick={() => { setSupplier('all'); setDateFrom(''); setDateTo(''); setQ(''); }}
            className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50">清空筛选</button>
        )}
      </div>

      <div className="text-xs text-gray-400 mb-2">
        {filtered.length} / {rows.length} 条收货{filtered.length > 0 && totals ? <> · 合计 <b className="text-gray-600">{totals}</b></> : null}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {filtered.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-400">没有匹配的收货记录</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="bg-gray-50 text-left text-gray-500">
                <th className="px-3 py-2">收货日期</th>
                <th className="px-3 py-2">供应商</th>
                <th className="px-3 py-2">物料</th>
                <th className="px-3 py-2">规格</th>
                <th className="px-3 py-2">颜色</th>
                <th className="px-3 py-2 text-center">尺码</th>
                <th className="px-3 py-2 text-right">数量</th>
                <th className="px-3 py-2 text-center">检验</th>
                <th className="px-3 py-2">采购单</th>
                <th className="px-3 py-2">关联订单</th>
              </tr></thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map((r) => {
                  const insp = INSPECT_CN[r.inspection_result || ''] || null;
                  return (
                    <tr key={r.id} className="hover:bg-indigo-50/30">
                      <td className="px-3 py-2 whitespace-nowrap text-gray-600">{fmtD(r.received_at)}</td>
                      <td className="px-3 py-2 text-gray-800">{r.supplier_name || <span className="text-gray-300">—</span>}</td>
                      <td className="px-3 py-2 font-medium text-gray-900">{r.material_name || '—'}</td>
                      <td className="px-3 py-2 text-gray-500">{r.specification || '—'}</td>
                      <td className="px-3 py-2">{r.color ? <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-700">{r.color}</span> : <span className="text-gray-300">—</span>}</td>
                      <td className="px-3 py-2 text-center">{r.size || <span className="text-gray-300">—</span>}</td>
                      <td className="px-3 py-2 text-right font-semibold text-gray-900 whitespace-nowrap">{r.received_qty} {r.unit || ''}</td>
                      <td className="px-3 py-2 text-center">
                        {insp ? <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${insp.cls}`}>{insp.label}</span> : '—'}
                        {r.return_status && <span className="block text-[10px] text-rose-500 mt-0.5">{RETURN_CN[r.return_status] || r.return_status}</span>}
                        {r.defect_notes && <span className="block text-[10px] text-amber-600 mt-0.5 max-w-[140px] truncate" title={r.defect_notes}>{r.defect_notes}</span>}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {r.purchase_order_id
                          ? <Link href={`/procurement/po/${r.purchase_order_id}`} className="text-indigo-600 hover:underline">{r.po_no || '查看'}</Link>
                          : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{r.order_label || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
