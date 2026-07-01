'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { backfillActualMaterialCost } from '@/app/actions/procurement-cost';

export function ProcurementCostClient({ data, orderId }: { data: any; orderId: string }) {
  const router = useRouter();
  const { order, summary, receivingDiff, current_actual_material_cost } = data;
  const [busy, setBusy] = useState(false);

  async function handleBackfill() {
    if (!confirm('以采购实际成本回填 actual_material_cost 并重算利润？（会覆盖当前值,来源标记为采购）')) return;
    setBusy(true);
    const res = await backfillActualMaterialCost(orderId);
    setBusy(false);
    if (res.error) { alert(res.error); return; }
    alert(`✅ 已回填实际材料成本 ¥${res.actual} 并重算利润`);
    router.refresh();
  }

  const v = summary.variance;
  const vp = summary.variance_pct;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">采购成本核算</h1>
        <p className="text-sm text-gray-500 mt-1">{order.internal_order_no || order.order_no} · {order.customer_name || '—'}</p>
      </div>

      {/* 成本核算 */}
      <section className="bg-white rounded-xl border border-gray-200 p-5">
        <h3 className="text-sm font-semibold text-gray-800 mb-3">实际采购成本 vs 预算</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <div><div className="text-xs text-gray-500">实际采购成本</div><div className="text-lg font-bold text-gray-900">¥{summary.actual_cost}</div></div>
          <div><div className="text-xs text-gray-500">材料预算</div><div className="text-lg font-bold text-gray-900">{summary.budget_material_cost != null ? `¥${summary.budget_material_cost}` : '—'}</div></div>
          <div><div className="text-xs text-gray-500">差异</div><div className={`text-lg font-bold ${v == null ? 'text-gray-400' : v > 0 ? 'text-red-600' : 'text-emerald-600'}`}>{v == null ? '—' : `${v > 0 ? '+' : ''}¥${v}`}</div></div>
          <div><div className="text-xs text-gray-500">差异%</div><div className={`text-lg font-bold ${vp == null ? 'text-gray-400' : vp > 0 ? 'text-red-600' : 'text-emerald-600'}`}>{vp == null ? '—' : `${vp > 0 ? '+' : ''}${vp}%`}</div></div>
        </div>
        <p className="text-[11px] text-gray-400 mt-2">口径:{summary.basis === 'received' ? '收货实际' : summary.basis === 'ordered' ? '订购金额' : summary.basis === 'mixed' ? '收货+订购混合' : '无行'} · {summary.line_count} 行</p>
      </section>

      {/* 回填 */}
      <section className="bg-white rounded-xl border border-gray-200 p-5 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-800">回填利润</h3>
          <p className="text-xs text-gray-500 mt-1">
            当前 actual_material_cost:{current_actual_material_cost != null ? `¥${current_actual_material_cost}` : '—'}
            {' '}· 回填=以采购实际成本覆盖并重算利润(人工选,不自动)
          </p>
        </div>
        <button onClick={handleBackfill} disabled={busy}
          className="shrink-0 text-xs px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 font-medium disabled:opacity-50">
          {busy ? '回填中…' : '以采购实际回填'}
        </button>
      </section>

      {/* 订收差异（非真尾货） */}
      <section className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-baseline gap-2 mb-3">
          <h3 className="text-sm font-semibold text-gray-800">订收差异</h3>
          <span className="text-[11px] text-amber-600">⚠️ 订了 vs 收了,**非真尾货**(真尾货=收了vs用了,需生产消耗链)</span>
        </div>
        {receivingDiff.over.length === 0 && receivingDiff.short.length === 0 ? (
          <p className="text-sm text-gray-400">无订收差异(或均未收货)</p>
        ) : (
          <div className="space-y-1.5 text-xs">
            {[...receivingDiff.over, ...receivingDiff.short].map((l: any, i: number) => (
              <div key={i} className="flex justify-between">
                <span className="text-gray-600">{l.material_name || '—'} · 订 {l.ordered_qty} / 收 {l.received_qty}</span>
                <span className={`font-mono ${l.diff_qty > 0 ? 'text-amber-600' : 'text-red-600'}`}>{l.diff_qty > 0 ? `超收 +${l.diff_qty}` : `短收 ${l.diff_qty}`} · ¥{l.diff_amount}</span>
              </div>
            ))}
            <div className="flex justify-between border-t border-gray-100 pt-2 mt-2 font-semibold">
              <span>差异合计</span><span className="font-mono">¥{receivingDiff.total_diff_amount}</span>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
