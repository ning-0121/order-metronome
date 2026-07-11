'use client';

import { useEffect, useState, useCallback } from 'react';
import { getPerPoBreakdown, submitPoOperation, type PoOperationInput } from '@/app/actions/order-amendments';
import { sortSizeKeys } from '@/lib/utils/size-sort';

/**
 * 多PO合单 P3a:订单详情「多PO管理」面板 —— 按来源PO取消/减量。
 * 只对多PO合单的订单(≥2张来源PO)渲染;操作走改单审批闸(开裁前),批准后减明细+同步采购/财务/生产。
 */
type Line = { id: string; source_order_po_id: string | null; style_no?: string; product_name?: string; color_cn?: string; color_en?: string; sizes?: Record<string, number>; qty_pcs?: number };
type Po = { id: string; customer_po_number: string; seq: number; status?: string };

const sumSizes = (s: any) => Object.values(s || {}).reduce((a: number, v: any) => a + (Number(v) || 0), 0);

export function PerPoOperationsPanel({ orderId }: { orderId: string }) {
  const [pos, setPos] = useState<Po[]>([]);
  const [linesByPo, setLinesByPo] = useState<Record<string, Line[]>>({});
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  // 当前操作中的 PO:{ poId, mode: 'cancel'|'reduce' }
  const [active, setActive] = useState<{ poId: string; mode: 'cancel' | 'reduce' } | null>(null);
  const [reason, setReason] = useState('');
  // reduce 模式:{ [lineId]: { [size]: 减量 } }
  const [reductions, setReductions] = useState<Record<string, Record<string, number>>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    const r = await getPerPoBreakdown(orderId);
    if ((r as any).pos) { setPos((r as any).pos); setLinesByPo((r as any).linesByPo || {}); }
    setLoading(false);
  }, [orderId]);
  useEffect(() => { load(); }, [load]);

  const poQty = (poId: string) => (linesByPo[poId] || []).reduce((a, l) => a + (Number(l.qty_pcs) || sumSizes(l.sizes)), 0);
  const activeCount = pos.filter((p) => (p.status || 'active') === 'active').length;

  function startOp(poId: string, mode: 'cancel' | 'reduce') {
    setActive({ poId, mode }); setReason(''); setReductions({}); setMsg('');
  }

  function setReduce(lineId: string, size: string, v: string) {
    const n = Math.max(0, Math.round(Number(v) || 0));
    setReductions((prev) => ({ ...prev, [lineId]: { ...(prev[lineId] || {}), [size]: n } }));
  }

  const reduceTotal = Object.values(reductions).reduce((a, m) => a + Object.values(m).reduce((b, v) => b + (Number(v) || 0), 0), 0);

  async function submit() {
    if (!active) return;
    if (reason.trim().length < 5) { setMsg('❌ 请填写原因(至少5字)'); return; }
    const po = pos.find((p) => p.id === active.poId);
    let op: PoOperationInput;
    if (active.mode === 'cancel') {
      op = { kind: 'cancel_po', source_order_po_id: active.poId, customer_po_number: po?.customer_po_number };
    } else {
      const line_reductions = Object.entries(reductions)
        .map(([line_item_id, sizes]) => {
          const reduce_sizes: Record<string, number> = {};
          for (const [k, v] of Object.entries(sizes)) if (Number(v) > 0) reduce_sizes[k] = Number(v);
          return { line_item_id, reduce_sizes };
        })
        .filter((lr) => Object.keys(lr.reduce_sizes).length > 0);
      if (line_reductions.length === 0) { setMsg('❌ 请至少填一处减量数量'); return; }
      op = { kind: 'reduce_po', source_order_po_id: active.poId, customer_po_number: po?.customer_po_number, line_reductions };
    }
    setBusy(true); setMsg('');
    const r = await submitPoOperation(orderId, op, reason.trim());
    setBusy(false);
    if ((r as any).error) { setMsg('❌ ' + (r as any).error); return; }
    setMsg('✅ 已提交,待管理员审批;批准后减明细并同步采购/财务/生产');
    setActive(null); setReason(''); setReductions({});
    setTimeout(() => setMsg(''), 3000);
    load();
  }

  if (loading || pos.length < 2) return null;   // 只对多PO合单单渲染

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="text-sm px-3 py-1.5 rounded-lg border border-amber-300 text-amber-700 hover:bg-amber-50 font-medium">
        ✂️ 多PO管理(取消 / 减量某张PO)
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/40 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-amber-800">✂️ 多PO管理 · 按来源PO取消/减量</div>
        <button onClick={() => { setOpen(false); setActive(null); setMsg(''); }} className="text-xs text-gray-400 hover:text-gray-600">收起</button>
      </div>
      <p className="text-[11px] text-gray-500">
        某张客户PO要单独取消或减量?操作走管理员审批(开裁前);批准后就地减明细,并同步采购(标「需重新确认」,不自动砍已下采购单)/财务/生产。
        改期请用「拆分独立成单」(P3b)。
      </p>

      <div className="space-y-2">
        {pos.map((po) => {
          const status = po.status || 'active';
          const qty = poQty(po.id);
          const lines = linesByPo[po.id] || [];
          const isActive = active?.poId === po.id;
          return (
            <div key={po.id} className="rounded-lg border border-gray-200 bg-white p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-xs font-medium">PO{po.seq} · {po.customer_po_number}</span>
                <span className="text-xs text-gray-500">{qty} 件 · {lines.length} 行</span>
                {status === 'cancelled' && <span className="text-xs px-1.5 py-0.5 rounded bg-rose-100 text-rose-700">已取消</span>}
                {status === 'split_out' && <span className="text-xs px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700">已拆出</span>}
                {status === 'active' && (
                  <span className="ml-auto flex items-center gap-2">
                    <button onClick={() => startOp(po.id, 'reduce')} className="text-xs px-2 py-1 rounded border border-amber-300 text-amber-700 hover:bg-amber-50">减量</button>
                    <button onClick={() => startOp(po.id, 'cancel')}
                      disabled={activeCount <= 1}
                      title={activeCount <= 1 ? '这是最后一张活跃PO,取消=整单取消,请走订单取消流程' : ''}
                      className="text-xs px-2 py-1 rounded border border-rose-300 text-rose-700 hover:bg-rose-50 disabled:opacity-40 disabled:cursor-not-allowed">取消该PO</button>
                  </span>
                )}
              </div>

              {isActive && (
                <div className="mt-2 border-t border-gray-100 pt-2 space-y-2">
                  {active!.mode === 'cancel' && (
                    <p className="text-xs text-rose-700">将取消 <b>PO{po.seq} · {po.customer_po_number}</b> 全部 {qty} 件({lines.length} 行明细减到 0),其余PO照常生产。</p>
                  )}
                  {active!.mode === 'reduce' && (
                    <div className="overflow-x-auto">
                      <table className="text-xs">
                        <thead>
                          <tr className="text-gray-400 text-left">
                            <th className="px-1 py-1 font-medium">款/色</th>
                            <th className="px-1 py-1 font-medium">当前</th>
                            <th className="px-1 py-1 font-medium">减量(按码)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {lines.map((l) => {
                            const keys = sortSizeKeys(Object.keys(l.sizes || {}).filter((k) => Number((l.sizes || {})[k]) > 0));
                            if (keys.length === 0) return null;
                            return (
                              <tr key={l.id} className="border-t border-gray-50 align-top">
                                <td className="px-1 py-1 whitespace-nowrap">{l.style_no || ''} · {[l.color_en, l.color_cn].filter(Boolean).join('/') || '—'}</td>
                                <td className="px-1 py-1 font-mono text-gray-500">{sumSizes(l.sizes)}</td>
                                <td className="px-1 py-1">
                                  <div className="flex flex-wrap gap-1.5">
                                    {keys.map((k) => (
                                      <label key={k} className="inline-flex items-center gap-0.5 text-[11px] text-gray-500">
                                        {k}<span className="text-gray-300">/{(l.sizes || {})[k]}</span>
                                        <input type="number" min="0" max={(l.sizes || {})[k]} value={reductions[l.id]?.[k] ?? ''}
                                          onChange={(e) => setReduce(l.id, k, e.target.value)}
                                          className="w-12 rounded border border-gray-300 px-1 py-0.5 text-center" />
                                      </label>
                                    ))}
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <label className="block">
                    <span className="text-xs text-gray-500">原因(至少5字)</span>
                    <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2}
                      placeholder={active!.mode === 'cancel' ? '如「客户砍掉这张PO」' : '如「客户这张PO减黑色M 50件」'}
                      className="w-full mt-1 rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
                  </label>
                  <div className="flex items-center gap-2">
                    <button onClick={submit} disabled={busy}
                      className={`text-sm px-4 py-1.5 rounded-lg text-white font-medium disabled:opacity-50 ${active!.mode === 'cancel' ? 'bg-rose-600 hover:bg-rose-700' : 'bg-amber-600 hover:bg-amber-700'}`}>
                      {busy ? '提交中…' : active!.mode === 'cancel' ? `提交取消审批（-${qty}件）` : `提交减量审批${reduceTotal > 0 ? `（-${reduceTotal}件）` : ''}`}
                    </button>
                    <button onClick={() => { setActive(null); setMsg(''); }} className="text-xs text-gray-400 hover:text-gray-600">放弃</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {msg && <div className={`text-xs ${msg.startsWith('✅') ? 'text-emerald-700' : 'text-rose-600'}`}>{msg}</div>}
      <p className="text-[11px] text-gray-400">提交后在下方「订单修改申请」列表可见,由管理员审批。</p>
    </div>
  );
}
