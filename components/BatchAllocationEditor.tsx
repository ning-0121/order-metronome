'use client';

/** 出货批次的款色分配编辑器:业务员填"这批出了每款每色各多少件",据此算剩余。 */

import { useEffect, useState } from 'react';
import { getBatchAllocation, setBatchAllocation } from '@/app/actions/leftover-goods';

export function BatchAllocationEditor({ orderId, batchId, canEdit, onSaved }: { orderId: string; batchId: string; canEdit: boolean; onSaved?: () => void }) {
  const [lines, setLines] = useState<any[] | null>(null);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    getBatchAllocation(orderId, batchId).then((r) => {
      if (r.data) {
        setLines(r.data.lines);
        const q: Record<string, string> = {};
        for (const l of r.data.lines) q[l.line_id] = l.qty_in_batch ? String(l.qty_in_batch) : '';
        setQty(q);
      } else setMsg(r.error || '加载失败');
    }).catch(() => setMsg('加载失败'));
  }, [orderId, batchId]);

  if (msg && !lines) return <div className="text-xs text-gray-400 px-2 py-1">{msg}</div>;
  if (lines === null) return <div className="text-xs text-gray-400 px-2 py-1">加载款色…</div>;
  if (lines.length === 0) return <div className="text-xs text-gray-400 px-2 py-1">此订单无逐款明细(order_line_items),无法按款色分配。</div>;

  const total = Object.values(qty).reduce((s, v) => s + (Number(v) || 0), 0);

  async function save() {
    setBusy(true); setMsg('');
    try {
      const items = lines!.map((l) => ({ order_line_item_id: l.line_id, qty: Number(qty[l.line_id]) || 0 }));
      const r = await setBatchAllocation(batchId, items);
      if (r.error) setMsg(r.error);
      else { setMsg('已保存 ✓'); onSaved?.(); }
    } finally { setBusy(false); }
  }

  return (
    <div className="mt-2 rounded-lg border border-gray-200 bg-gray-50 p-2">
      <div className="mb-1 text-xs font-medium text-gray-600">本批款色分配(填各款色出了多少件)</div>
      <div className="max-h-56 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="text-left text-gray-400">
            <tr><th className="py-1 pr-2 font-medium">款号 / 颜色</th><th className="py-1 pr-2 font-medium">订单件</th><th className="py-1 font-medium">本批出</th></tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.line_id} className="border-t border-gray-100">
                <td className="py-1 pr-2">{l.style_no || l.product_name || '—'}{l.color ? ` · ${l.color}` : ''}</td>
                <td className="py-1 pr-2 tabular-nums text-gray-500">{l.ordered}</td>
                <td className="py-1">
                  <input type="number" min={0} value={qty[l.line_id] ?? ''} disabled={!canEdit}
                    onChange={(e) => setQty((q) => ({ ...q, [l.line_id]: e.target.value }))}
                    className="w-20 rounded border border-gray-300 px-1.5 py-0.5 text-xs disabled:bg-gray-100" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex items-center justify-between">
        <span className="text-xs text-gray-500">本批合计 <b className="tabular-nums">{total}</b> 件</span>
        {canEdit && (
          <button onClick={save} disabled={busy}
            className="rounded-lg bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
            {busy ? '保存中…' : '保存分配'}
          </button>
        )}
      </div>
      {msg && <div className="mt-1 text-[11px] text-gray-500">{msg}</div>}
    </div>
  );
}
