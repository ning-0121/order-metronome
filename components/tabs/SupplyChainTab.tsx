'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { getOrderSupplyChainOverview, type SupplyChainOverview } from '@/app/actions/supply-chain';

const CAT: Record<string, string> = {
  fabric: '面料', trim: '辅料', trims: '辅料', packing: '包装', packaging: '包装', print: '印花', other: '其他',
};
const STATUS: Record<string, string> = {
  draft: '待下单', pending_order: '待下单', ordered: '已下单', confirmed: '已确认',
  in_production: '生产中', shipped: '已发货', arrived: '已到厂',
  accepted: '已验收', concession: '让步收', rejected: '已拒收', closed: '已完成',
};
const STATUS_TONE: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-600', pending_order: 'bg-indigo-100 text-indigo-700',
  ordered: 'bg-amber-100 text-amber-700', confirmed: 'bg-amber-100 text-amber-700',
  in_production: 'bg-amber-100 text-amber-700', shipped: 'bg-blue-100 text-blue-700',
  arrived: 'bg-emerald-100 text-emerald-700', accepted: 'bg-emerald-100 text-emerald-700',
  concession: 'bg-amber-100 text-amber-700', rejected: 'bg-red-100 text-red-700', closed: 'bg-gray-100 text-gray-500',
};

function fmt(d: string | null) { return d ? d.slice(0, 10) : '—'; }

export function SupplyChainTab({ orderId }: { orderId: string }) {
  const [data, setData] = useState<SupplyChainOverview | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getOrderSupplyChainOverview(orderId).then((r) => {
      if (cancelled) return;
      if (r.data) setData(r.data);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [orderId]);

  if (loading) return <div className="text-center py-8 text-gray-400 text-sm">加载中...</div>;
  if (!data) return <div className="text-center py-8 text-gray-400 text-sm">暂无供应链数据</div>;

  const { statusCounts: sc, attentionCount, byCategory, receipts, budget, canSeeFinancials, lines } = data;
  const hasLines = lines.length > 0;

  const stats = [
    { label: '待下单', value: sc.pending, tone: 'border-indigo-200 bg-indigo-50 text-indigo-800' },
    { label: '在途', value: sc.inTransit, tone: 'border-amber-200 bg-amber-50 text-amber-800' },
    { label: '已到厂', value: sc.arrived, tone: 'border-blue-200 bg-blue-50 text-blue-800' },
    { label: '已验收', value: sc.done, tone: 'border-emerald-200 bg-emerald-50 text-emerald-800' },
    { label: '⚠️ 需关注', value: attentionCount, tone: 'border-rose-200 bg-rose-50 text-rose-800' },
  ];

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">🔗 供应链概览</h2>
        <p className="text-xs text-gray-500 mt-0.5">
          归集本订单的物料采购 / 到货 / 预算现状(只读)。具体操作请到下方对应 Tab。
        </p>
      </div>

      {/* 物料采购状态 */}
      <div className="grid grid-cols-3 md:grid-cols-5 gap-3">
        {stats.map((s) => (
          <div key={s.label} className={`rounded-xl border px-3 py-3 ${s.tone}`}>
            <div className="text-2xl font-bold">{s.value}</div>
            <div className="text-xs mt-0.5 opacity-80">{s.label}</div>
          </div>
        ))}
      </div>

      {/* 物料预算（红线：仅财务） */}
      {canSeeFinancials && (
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-sm font-semibold text-gray-800 mb-2">🧵 物料预算</p>
          {budget && (budget.budget_fabric_kg || budget.budget_fabric_amount) ? (
            <div className="flex flex-wrap gap-x-8 gap-y-1 text-sm">
              <span className="text-gray-500">单件用量 <strong className="text-gray-800 font-mono">{budget.fabric_consumption_kg ?? '—'} KG</strong></span>
              <span className="text-gray-500">预算面料 <strong className="text-indigo-700 font-mono">{budget.budget_fabric_kg ?? '—'} KG</strong></span>
              <span className="text-gray-500">预算金额 <strong className="text-indigo-700 font-mono">¥{budget.budget_fabric_amount?.toLocaleString() ?? '—'}</strong></span>
            </div>
          ) : (
            <p className="text-xs text-amber-600">
              未建立成本基线。请到「💰 成本控制」Tab 上传核算单或手工录入预算。
            </p>
          )}
        </div>
      )}

      {/* 物料明细（只读） */}
      <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-gray-100 flex items-center justify-between">
          <span className="text-sm font-semibold text-gray-800">物料采购明细（{lines.length}）</span>
          <span className="text-xs text-gray-400">
            {Object.entries(byCategory).map(([k, v]) => `${CAT[k] || k} ${v}`).join(' · ')}
          </span>
        </div>
        {!hasLines ? (
          <p className="px-4 py-6 text-center text-sm text-gray-400">
            本订单暂无采购物料行。可到「📦 采购进度」Tab 录入。
          </p>
        ) : (
          <div className="divide-y divide-gray-100">
            {lines.map((l) => (
              <div key={l.id} className="px-4 py-2.5 flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-medium text-gray-900 truncate">{l.material_name || '—'}</span>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">{CAT[l.category || 'other'] || l.category}</span>
                  {l.supplier_name && <span className="text-xs text-gray-400 truncate">· {l.supplier_name}</span>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {l.overdue && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-100 text-red-700">逾期</span>}
                  <span className="text-xs text-gray-400">
                    {l.line_status === 'arrived' || l.line_status === 'accepted'
                      ? `实收 ${l.received_qty ?? '—'}`
                      : `需到 ${fmt(l.required_by)}`}
                  </span>
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${STATUS_TONE[l.line_status] || 'bg-gray-100 text-gray-500'}`}>
                    {STATUS[l.line_status] || l.line_status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 到货验收概要 */}
      {receipts.total > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-sm font-semibold text-gray-800 mb-2">📥 到货验收（{receipts.total} 批）</p>
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <span className="text-emerald-700">通过 {receipts.pass}</span>
            <span className="text-amber-700">让步 {receipts.concession}</span>
            <span className="text-red-700">拒收 {receipts.reject}</span>
            {receipts.pending > 0 && <span className="text-gray-500">待检 {receipts.pending}</span>}
          </div>
        </div>
      )}

      {/* 快捷入口到现有操作 Tab（不重复造，归集后跳转） */}
      <div className="flex flex-wrap gap-2 pt-1">
        <Link href={`/orders/${orderId}?tab=procurement`} className="px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-700 hover:bg-gray-50">📦 去采购进度</Link>
        <Link href={`/orders/${orderId}?tab=bom`} className="px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-700 hover:bg-gray-50">🧵 原辅料 / BOM（{data.bomCount}）</Link>
        {canSeeFinancials && (
          <Link href={`/orders/${orderId}?tab=cost_control`} className="px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-700 hover:bg-gray-50">💰 成本控制</Link>
        )}
      </div>
    </div>
  );
}
