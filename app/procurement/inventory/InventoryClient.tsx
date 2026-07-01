'use client';

import { useState, Fragment } from 'react';
import { useRouter } from 'next/navigation';
import { recordInventoryIssue, recordInventoryReturn, getInventoryTransactions } from '@/app/actions/inventory';

type Mode = 'issue' | 'return';

const TXN_LABEL: Record<string, { t: string; cls: string }> = {
  receipt: { t: '入库', cls: 'text-emerald-700 bg-emerald-50' },
  issue: { t: '领料', cls: 'text-indigo-700 bg-indigo-50' },
  return: { t: '退料', cls: 'text-amber-700 bg-amber-50' },
  adjust: { t: '盘点', cls: 'text-gray-600 bg-gray-100' },
  scrap: { t: '报废', cls: 'text-red-700 bg-red-50' },
};

export function InventoryClient({ balance, orders, canIssue }: { balance: any[]; orders: any[]; canIssue: boolean }) {
  const router = useRouter();
  const [active, setActive] = useState<{ key: string; mode: Mode } | null>(null);
  const [orderId, setOrderId] = useState('');
  const [qty, setQty] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  // 流水明细(W3a):按需拉取,逐物料展开
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [detailTxns, setDetailTxns] = useState<any[]>([]);
  const [detailBusy, setDetailBusy] = useState(false);
  const orderLabel = (id: string) => {
    const o = orders.find((x: any) => x.id === id);
    return o ? (o.internal_order_no || o.order_no) : id.slice(0, 8);
  };

  function open(row: any, mode: Mode) {
    setActive({ key: row.material_key, mode });
    setOrderId(''); setQty(''); setNote('');
  }

  async function toggleDetail(row: any) {
    if (detailKey === row.material_key) { setDetailKey(null); return; }
    setDetailKey(row.material_key); setDetailBusy(true); setDetailTxns([]);
    const res = await getInventoryTransactions(row.material_key);
    setDetailBusy(false);
    if (res.error) { alert(res.error); setDetailKey(null); return; }
    setDetailTxns(res.data || []);
  }

  async function submit(row: any) {
    const q = Number(qty);
    if (!(q > 0)) { alert('数量必须大于 0'); return; }
    setBusy(true);
    const input = { materialKey: row.material_key, materialName: row.material_name, unit: row.unit, orderId: orderId || null, qty: q, note: note || undefined };
    const res = active!.mode === 'issue' ? await recordInventoryIssue(input) : await recordInventoryReturn(input);
    setBusy(false);
    if (res.error) { alert(res.error); return; }
    setActive(null);
    if (detailKey === row.material_key) { const r = await getInventoryTransactions(row.material_key); setDetailTxns(r.data || []); }
    router.refresh();
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
            <th className="px-4 py-2 font-medium text-right">操作</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {balance.map((b: any) => (
            <Fragment key={b.material_key}>
              <tr className="hover:bg-gray-50">
                <td className="px-4 py-2.5 text-gray-800">{b.material_name || b.material_key}</td>
                <td className={`px-4 py-2.5 text-right font-mono font-semibold ${b.on_hand < 0 ? 'text-red-600' : 'text-gray-900'}`}>{b.on_hand}</td>
                <td className="px-4 py-2.5 text-gray-500 text-xs">{b.unit || '—'}</td>
                <td className="px-4 py-2.5 text-right whitespace-nowrap">
                  <button onClick={() => toggleDetail(b)} className="text-xs px-2 py-1 rounded bg-gray-50 text-gray-600 border border-gray-200 hover:bg-gray-100 mr-1">{detailKey === b.material_key ? '收起' : '明细'}</button>
                  {canIssue && (
                    <>
                      <button onClick={() => open(b, 'issue')} className="text-xs px-2 py-1 rounded bg-indigo-50 text-indigo-700 border border-indigo-200 hover:bg-indigo-100 mr-1">领料</button>
                      <button onClick={() => open(b, 'return')} className="text-xs px-2 py-1 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100">退料</button>
                    </>
                  )}
                </td>
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
              {detailKey === b.material_key && (
                <tr>
                  <td colSpan={4} className="px-4 py-3 bg-gray-50/60">
                    {detailBusy ? (
                      <p className="text-xs text-gray-400">加载流水…</p>
                    ) : detailTxns.length === 0 ? (
                      <p className="text-xs text-gray-400">暂无流水</p>
                    ) : (
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-left text-gray-400">
                            <th className="px-2 py-1 font-medium">时间</th>
                            <th className="px-2 py-1 font-medium">类型</th>
                            <th className="px-2 py-1 font-medium text-right">数量</th>
                            <th className="px-2 py-1 font-medium">订单</th>
                            <th className="px-2 py-1 font-medium">备注</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detailTxns.map((t: any) => {
                            const lbl = TXN_LABEL[t.txn_type] || { t: t.txn_type, cls: 'text-gray-600 bg-gray-100' };
                            return (
                              <tr key={t.id} className="border-t border-gray-100">
                                <td className="px-2 py-1 text-gray-500 whitespace-nowrap">{(t.created_at || '').slice(0, 16).replace('T', ' ')}</td>
                                <td className="px-2 py-1"><span className={`inline-block px-1.5 py-0.5 rounded ${lbl.cls}`}>{lbl.t}</span></td>
                                <td className={`px-2 py-1 text-right font-mono ${t.qty < 0 ? 'text-red-600' : 'text-gray-800'}`}>{t.qty > 0 ? `+${t.qty}` : t.qty}</td>
                                <td className="px-2 py-1 text-gray-500">{t.order_id ? orderLabel(t.order_id) : '—'}</td>
                                <td className="px-2 py-1 text-gray-500">{t.note || '—'}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
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
