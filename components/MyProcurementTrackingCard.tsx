'use client';

/**
 * 首页「我的采购追踪」板块 —— 业务看自己每个订单的采购进度 + 到期提醒待办。
 * 数据来自 getMyProcurementTracking(按 owner/creator 过滤);无采购活动时整块隐藏。
 * 「采购单 N 张」可点开,逐张看单独的供应商/状态/进度/预计到货(2026-07-09)。
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getMyProcurementTracking, type MyProcOrderRow, type MyProcPoRow } from '@/app/actions/my-procurement-tracking';

const PO_STATUS_CN: Record<string, string> = {
  draft: '草稿', placed: '已下单', confirmed: '已确认',
  receiving: '收货中', received: '已到齐', closed: '已关闭', cancelled: '已取消',
};
const mdShort = (d: string | null) => (d ? d.slice(5) : null);   // YYYY-MM-DD → MM-DD

function ProgressBar({ received, total }: { received: number; total: number }) {
  const pct = total > 0 ? Math.round((received / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2 min-w-[120px]">
      <div className="flex-1 h-1.5 rounded-full bg-gray-100 overflow-hidden">
        <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-gray-500 shrink-0">{received}/{total}</span>
    </div>
  );
}

export function MyProcurementTrackingCard() {
  const [rows, setRows] = useState<MyProcOrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    getMyProcurementTracking().then((res) => {
      if ((res as any).data) setRows((res as any).data);
      setLoading(false);
    });
  }, []);

  const toggle = (orderId: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(orderId)) next.delete(orderId); else next.add(orderId);
      return next;
    });

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
              <th className="py-2 px-3 font-medium">工厂交期</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const isOpen = expanded.has(r.order_id);
              const canExpand = r.pos.length > 0;
              return (
                <FragmentRow
                  key={r.order_id}
                  r={r}
                  isOpen={isOpen}
                  canExpand={canExpand}
                  onToggle={() => toggle(r.order_id)}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FragmentRow({
  r, isOpen, canExpand, onToggle,
}: { r: MyProcOrderRow; isOpen: boolean; canExpand: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className="border-b border-gray-50 hover:bg-gray-50/60">
        <td className="py-2 px-3">
          <Link href={`/orders/${r.order_id}`} className="text-indigo-600 hover:underline font-medium">
            {r.order_no || r.order_id.slice(0, 8)}
          </Link>
        </td>
        <td className="py-2 px-3 text-gray-600">{r.customer_name || '—'}</td>
        <td className="py-2 px-3">
          {r.po_count > 0 ? (
            <button
              type="button"
              onClick={canExpand ? onToggle : undefined}
              disabled={!canExpand}
              className={`inline-flex items-center gap-1 text-gray-600 ${canExpand ? 'hover:text-indigo-600 cursor-pointer' : 'cursor-default'}`}
              title={canExpand ? '点开看每张采购单的进度' : undefined}
            >
              <span>{r.po_count} 张</span>
              {canExpand && (
                <span className={`text-[10px] text-gray-400 transition-transform ${isOpen ? 'rotate-90' : ''}`}>▸</span>
              )}
            </button>
          ) : <span className="text-gray-600">—</span>}
        </td>
        <td className="py-2 px-3">
          {r.total_lines > 0 ? (
            <div className="flex items-center gap-2">
              <ProgressBar received={r.received_lines} total={r.total_lines} />
              {r.next_arrival && (
                <span className="text-[11px] text-amber-600 shrink-0 whitespace-nowrap">预计 {mdShort(r.next_arrival)} 到</span>
              )}
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
      {isOpen && r.pos.map((p) => <PoDetailRow key={p.po_id} p={p} />)}
    </>
  );
}

function PoDetailRow({ p }: { p: MyProcPoRow }) {
  return (
    <tr className="border-b border-gray-50 bg-gray-50/40 text-xs">
      <td className="py-1.5 px-3 pl-6 text-gray-500">
        <span className="text-gray-300 mr-1">↳</span>
        <span className="font-mono text-gray-600">{p.po_no || p.po_id.slice(0, 8)}</span>
      </td>
      <td className="py-1.5 px-3 text-gray-500">{p.supplier_name || '—'}</td>
      <td className="py-1.5 px-3 text-gray-500">{p.status ? (PO_STATUS_CN[p.status] || p.status) : '—'}</td>
      <td className="py-1.5 px-3">
        {p.total_lines > 0
          ? <ProgressBar received={p.received_lines} total={p.total_lines} />
          : <span className="text-gray-400">无明细</span>}
      </td>
      <td className="py-1.5 px-3 text-gray-400">—</td>
      <td className="py-1.5 px-3 text-gray-500">
        {p.delivery_date
          ? <span className="text-amber-600">预计 {mdShort(p.delivery_date)} 到</span>
          : <span className="text-gray-300">未定到货日</span>}
      </td>
    </tr>
  );
}
