'use client';

import { useState, useEffect } from 'react';
import { getCrossOrderNetting } from '@/app/actions/procurement-netting';
import { createPurchaseOrder } from '@/app/actions/purchase-orders';
import { listSuppliers } from '@/app/actions/suppliers';
import type { NettingGroup } from '@/lib/services/netting';

export function NettingClient() {
  const [groups, setGroups] = useState<NettingGroup[]>([]);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [buildKey, setBuildKey] = useState<string | null>(null);
  const [supplierId, setSupplierId] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function load() {
    setLoading(true);
    const [g, s] = await Promise.all([getCrossOrderNetting(), listSuppliers()]);
    setGroups(g.data || []);
    setSuppliers(s.data || []);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  async function handleBuild(group: NettingGroup) {
    if (!supplierId) { alert('请选择供应商'); return; }
    setSubmitting(true);
    const res = await createPurchaseOrder({ supplierId, lineItemIds: group.line_ids });
    setSubmitting(false);
    if (res.error) { alert(res.error); return; }
    alert(`✅ 已建采购单 ${res.poNo}`);
    setBuildKey(null); setSupplierId('');
    load();
  }

  if (loading) return <p className="text-sm text-gray-400">加载中…</p>;
  if (groups.length === 0) {
    return <div className="rounded-xl border-2 border-dashed border-gray-200 p-12 text-center text-sm text-gray-400">暂无未归单的待下单采购行</div>;
  }

  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <div key={g.key} className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-gray-900 truncate">{g.material_name}</h3>
                {g.order_count > 1 && (
                  <span className="shrink-0 text-[10px] px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700">跨 {g.order_count} 单</span>
                )}
              </div>
              <p className="text-xs text-gray-500 mt-0.5">
                {g.specification || '—'} · 共 <b>{g.total_qty}</b> {g.unit || ''} · {g.line_ids.length} 行
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {g.contributors.map((c) => (
                  <span key={c.line_id} className="text-[11px] px-2 py-0.5 rounded bg-gray-50 border border-gray-200 text-gray-600">
                    {c.order_ref}: {c.qty}
                  </span>
                ))}
              </div>
            </div>
            <button onClick={() => { setBuildKey(g.key); setSupplierId(''); }}
              className="shrink-0 text-xs px-3 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 font-medium">
              建采购单
            </button>
          </div>

          {buildKey === g.key && (
            <div className="mt-4 pt-4 border-t border-gray-100 flex items-end gap-2">
              <div className="flex-1">
                <label className="block text-xs text-gray-500 mb-1">供应商</label>
                <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white">
                  <option value="">— 选择供应商 —</option>
                  {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <button onClick={() => handleBuild(g)} disabled={submitting || !supplierId}
                className="text-xs px-4 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 font-medium disabled:opacity-50">
                {submitting ? '建单中…' : '确认建单'}
              </button>
              <button onClick={() => setBuildKey(null)}
                className="text-xs px-3 py-2 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50">取消</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
