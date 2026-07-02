'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { exportPurchaseOrder, placePurchaseOrder, approvePurchaseOrder } from '@/app/actions/purchase-orders';

const REASON_LABELS: Record<string, string> = {
  large_amount: '大额(≥5万)', price_variance: '价格偏差>5%', new_supplier: '新供应商',
  over_budget: '超预算', non_standard_terms: '非标账期(<60天)',
};

export function PurchaseOrderDetailClient({ view }: { view: any }) {
  const router = useRouter();
  const { po, lines, orderRefs, canSeeFloor, canProcure, canApproveProcurement, canApproveFinance } = view;
  const sup = po.suppliers || {};
  const [exporting, setExporting] = useState(false);
  const [busy, setBusy] = useState('');

  async function handlePlace() {
    setBusy('place');
    const res = await placePurchaseOrder(po.id);
    setBusy('');
    if (res.error) { alert(res.error); return; }
    if (res.pendingApproval) { alert('已转审批 · 触发:' + (res.reasons || []).map((r: string) => REASON_LABELS[r] || r).join('、')); router.refresh(); return; }
    alert('✅ 已下单'); router.refresh();
  }
  async function handleApprove() {
    const note = window.prompt('审批意见（可选）:');
    if (note === null) return;
    setBusy('approve');
    const res = await approvePurchaseOrder(po.id, note || undefined);
    setBusy('');
    if (res.error) { alert(res.error); return; }
    alert('✅ 审批通过'); router.refresh();
  }

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

      {/* 审批 / 下单（P2a）—— 卡风险不走流程 */}
      {po.status === 'draft' && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-800">审批 / 下单</h3>
            {po.approval_status === 'pending' ? (
              <p className="text-sm text-amber-700 mt-1">
                ⏳ 待审批 · 触发:{(po.approval_reasons || []).map((r: string) => REASON_LABELS[r] || r).join('、')}
                {' '}· 需 {(po.approval_required_by || []).join(' + ')} 审批
              </p>
            ) : po.approval_status === 'approved' ? (
              <p className="text-sm text-emerald-700 mt-1">✅ 已审批,可下单</p>
            ) : (
              <p className="text-sm text-gray-500 mt-1">草稿 · 点"下单"自动查风险:标准单直接下单,风险单转审批</p>
            )}
          </div>
          <div className="flex gap-2 shrink-0">
            {po.approval_status === 'pending' && (canApproveProcurement || canApproveFinance) && (
              <button onClick={handleApprove} disabled={busy !== ''}
                className="text-xs px-4 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 font-medium disabled:opacity-50">
                {busy === 'approve' ? '审批中…' : '✅ 审批通过'}
              </button>
            )}
            {canProcure && po.approval_status !== 'pending' && (
              <button onClick={handlePlace} disabled={busy !== ''}
                className="text-xs px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 font-medium disabled:opacity-50">
                {busy === 'place' ? '处理中…' : '📦 下单'}
              </button>
            )}
          </div>
        </div>
      )}

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
        <div className="px-4 py-3 border-b border-gray-100 text-sm font-semibold text-gray-700 flex items-center gap-2">
          采购行 {lines.length} {!canSeeFloor && <span className="text-xs font-normal text-gray-400">（业务视图:仅建议价）</span>}
          {po.merge_same_materials && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200">
              🔗 合并同料 · 导出时同料并为一行
            </span>
          )}
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
