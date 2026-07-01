'use client';

import { useState } from 'react';
import { exportPurchaseOrder } from '@/app/actions/purchase-orders';

export function PurchaseOrderDetailClient({ view }: { view: any }) {
  const { po, lines, orderRefs, canSeeFloor } = view;
  const sup = po.suppliers || {};
  const [exporting, setExporting] = useState(false);

  const dualNo = `${po.po_no} · 订单 ${(orderRefs || []).map((o: any) => o.internal_order_no || o.order_no).join(' / ') || '—'}`;

  async function handleExport() {
    setExporting(true);
    const res = await exportPurchaseOrder(po.id);
    setExporting(false);
    if (res.error) { alert(res.error); return; }
    if (res.base64 && res.fileName) {
      const bin = atob(res.base64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([arr], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const a = document.createElement('a'); a.href = url; a.download = res.fileName;
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{po.po_no}</h1>
          <p className="text-sm text-gray-500 mt-1">{dualNo}</p>
        </div>
        {canSeeFloor && (
          <button onClick={handleExport} disabled={exporting}
            className="text-xs px-3 py-2 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 font-medium disabled:opacity-50">
            {exporting ? '导出中…' : '📥 导出采购单'}
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-white rounded-xl border border-gray-200 p-5 text-sm space-y-1.5">
          <h3 className="font-semibold text-gray-800 mb-2">供应商</h3>
          <div className="flex justify-between"><span className="text-gray-500">名称</span><span>{sup.name || '—'}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">联系人</span><span>{sup.contact_name || '—'} {sup.phone || ''}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">付款/账期</span><span>{sup.payment_method || '—'} / {sup.net_days != null ? sup.net_days + '天' : '—'}</span></div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-5 text-sm space-y-1.5">
          <h3 className="font-semibold text-gray-800 mb-2">采购单</h3>
          <div className="flex justify-between"><span className="text-gray-500">状态</span><span>{po.status}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">交期</span><span>{po.delivery_date || '—'}</span></div>
          {canSeeFloor && <div className="flex justify-between"><span className="text-gray-500">合计</span><span className="font-semibold">{po.currency} {po.total_amount ?? '—'}</span></div>}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 text-sm font-semibold text-gray-700">
          采购行 {lines.length} {!canSeeFloor && <span className="text-xs font-normal text-gray-400">（业务视图:仅建议价）</span>}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="bg-gray-50 text-left text-gray-500">
              <th className="px-3 py-2">物料</th><th className="px-3 py-2">规格</th>
              <th className="px-3 py-2 text-center">数量</th><th className="px-3 py-2 text-right">建议价</th>
              {canSeeFloor && <th className="px-3 py-2 text-right">底价</th>}
              {canSeeFloor && <th className="px-3 py-2 text-right">金额</th>}
            </tr></thead>
            <tbody className="divide-y divide-gray-100">
              {lines.map((l: any) => (
                <tr key={l.id}>
                  <td className="px-3 py-2">{l.material_name}</td>
                  <td className="px-3 py-2 text-gray-500">{l.specification || '—'}</td>
                  <td className="px-3 py-2 text-center">{l.ordered_qty} {l.ordered_unit}</td>
                  <td className="px-3 py-2 text-right">{l.price_baseline ?? '—'}</td>
                  {canSeeFloor && <td className="px-3 py-2 text-right font-mono">{l.unit_price ?? '—'}</td>}
                  {canSeeFloor && <td className="px-3 py-2 text-right font-mono">{l.ordered_amount ?? '—'}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
