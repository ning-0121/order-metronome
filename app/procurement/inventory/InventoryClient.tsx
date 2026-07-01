'use client';

import { useState, Fragment } from 'react';
import { useRouter } from 'next/navigation';
import { recordInventoryIssue, recordInventoryReturn } from '@/app/actions/inventory';

type Mode = 'issue' | 'return';

export function InventoryClient({ balance, orders, canIssue }: { balance: any[]; orders: any[]; canIssue: boolean }) {
  const router = useRouter();
  const [active, setActive] = useState<{ key: string; mode: Mode } | null>(null);
  const [orderId, setOrderId] = useState('');
  const [qty, setQty] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  function open(row: any, mode: Mode) {
    setActive({ key: row.material_key, mode });
    setOrderId(''); setQty(''); setNote('');
  }

  async function submit(row: any) {
    const q = Number(qty);
    if (!(q > 0)) { alert('数量必须大于 0'); return; }
    setBusy(true);
    const input = { materialKey: row.material_key, materialName: row.material_name, unit: row.unit, orderId: orderId || null, qty: q, note: note || undefined };
    const res = active!.mode === 'issue' ? await recordInventoryIssue(input) : await recordInventoryReturn(input);
    setBusy(false);
    if (res.error) { alert(res.error); return; }
    setActive(null); router.refresh();
  }

  if (balance.length === 0) {
    return <div className="rounded-xl border-2 border-dashed border-gray-200 p-12 text-center text-sm text-gray-400">暂无库存流水(采购收货后自动入库)</div>;
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-50 text-left text-xs text-gray-500">
            <th className="px-4 py-2 font-medium">物料</th>
            <th className="px-4 py-2 font-medium text-right">在库</th>
            <th className="px-4 py-2 font-medium">单位</th>
            {canIssue && <th className="px-4 py-2 font-medium text-right">操作</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {balance.map((b: any) => (
            <Fragment key={b.material_key}>
              <tr className="hover:bg-gray-50">
                <td className="px-4 py-2.5 text-gray-800">{b.material_name || b.material_key}</td>
                <td className={`px-4 py-2.5 text-right font-mono font-semibold ${b.on_hand < 0 ? 'text-red-600' : 'text-gray-900'}`}>{b.on_hand}</td>
                <td className="px-4 py-2.5 text-gray-500 text-xs">{b.unit || '—'}</td>
                {canIssue && (
                  <td className="px-4 py-2.5 text-right whitespace-nowrap">
                    <button onClick={() => open(b, 'issue')} className="text-xs px-2 py-1 rounded bg-indigo-50 text-indigo-700 border border-indigo-200 hover:bg-indigo-100 mr-1">领料</button>
                    <button onClick={() => open(b, 'return')} className="text-xs px-2 py-1 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100">退料</button>
                  </td>
                )}
              </tr>
              {active?.key === b.material_key && (
                <tr>
                  <td colSpan={4} className="px-4 py-3 bg-gray-50">
                    <div className="flex flex-wrap items-end gap-2">
                      <span className="text-xs font-medium text-gray-600">{active.mode === 'issue' ? '领料' : '退料'}:{b.material_name}</span>
                      <select value={orderId} onChange={(e) => setOrderId(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5 text-xs bg-white">
                        <option value="">— 挂订单(可选) —</option>
                        {orders.map((o: any) => <option key={o.id} value={o.id}>{o.internal_order_no || o.order_no} · {o.customer_name || ''}</option>)}
                      </select>
                      <input type="number" step="0.001" value={qty} onChange={(e) => setQty(e.target.value)} placeholder={`数量 ${b.unit || ''}`} className="w-28 rounded-lg border border-gray-300 px-2 py-1.5 text-xs" />
                      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="备注(可选)" className="flex-1 min-w-[120px] rounded-lg border border-gray-300 px-2 py-1.5 text-xs" />
                      <button onClick={() => submit(b)} disabled={busy} className="text-xs px-3 py-1.5 rounded-lg bg-gray-900 text-white hover:bg-black disabled:opacity-50">{busy ? '提交中…' : '确认'}</button>
                      <button onClick={() => setActive(null)} className="text-xs px-2 py-1.5 rounded-lg border border-gray-200 text-gray-500">取消</button>
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
