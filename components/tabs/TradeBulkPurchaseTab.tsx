'use client';

import { useEffect, useState } from 'react';
import { getTradeBulkData, createTradeBulkPurchaseOrder, uploadTradePoProof, type TradeBulkLine } from '@/app/actions/trade-purchase';
import { placePurchaseOrder } from '@/app/actions/purchase-orders';

const money = (n: number) => '¥' + (Math.round(n * 100) / 100).toLocaleString();

function poStatusLabel(po: any): { text: string; cls: string } {
  if (po.status === 'cancelled') return { text: '已作废', cls: 'bg-gray-100 text-gray-500' };
  if (po.status && po.status !== 'draft') return { text: '已下达', cls: 'bg-green-100 text-green-700' };
  if (po.approval_status === 'pending') return { text: '待财务审批', cls: 'bg-amber-100 text-amber-700' };
  if (po.approval_status === 'rejected') return { text: '审批驳回', cls: 'bg-red-100 text-red-700' };
  return { text: '草稿', cls: 'bg-blue-100 text-blue-700' };
}

export function TradeBulkPurchaseTab({ orderId }: { orderId: string }) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<Awaited<ReturnType<typeof getTradeBulkData>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [terms, setTerms] = useState('月结');
  const [delivery, setDelivery] = useState('');

  async function load() {
    setLoading(true);
    const d = await getTradeBulkData(orderId);
    setData(d);
    setLoading(false);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [orderId]);

  if (loading) return <p className="text-sm text-gray-400 py-8 text-center">加载中…</p>;
  if (data?.error) return <p className="text-sm text-red-600 py-8 text-center">{data.error}</p>;
  if (data && data.isTrade === false) return <p className="text-sm text-gray-400 py-8 text-center">仅经销单有大货采购。</p>;

  const lines: TradeBulkLine[] = data?.lines || [];
  const pos = data?.pos || [];
  const activePo = pos.find((p: any) => p.status !== 'cancelled');
  const hasCost = lines.some((l) => (l.purchase_unit_cost || 0) > 0 && l.qty > 0);

  async function createPo() {
    if (!supplierId) { setErr('请选择供应商'); return; }
    setBusy(true); setErr(''); setMsg('');
    const res = await createTradeBulkPurchaseOrder(orderId, { supplierId, paymentTerms: terms, deliveryDate: delivery || undefined });
    setBusy(false);
    if (res.error) { setErr(res.error); return; }
    setMsg(`已生成大货采购单 ${res.poNo}(草稿)。采购上传下单凭证后即可下达、推财务建应付。`);
    load();
  }

  async function onProof(poId: string, file: File) {
    setBusy(true); setErr(''); setMsg('');
    const b64 = await new Promise<string>((resolve, reject) => {
      const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = reject; r.readAsDataURL(file);
    });
    const res = await uploadTradePoProof(orderId, poId, b64, file.name);
    setBusy(false);
    if (res.error) { setErr(res.error); return; }
    setMsg('下单凭证已上传,可以下达了。'); load();
  }

  async function place(poId: string) {
    setBusy(true); setErr(''); setMsg('');
    const res = await placePurchaseOrder(poId);
    setBusy(false);
    if (res.error) { setErr(res.error); return; }
    if (res.pendingApproval) setMsg('已提交财务前置审批,财务通过后自动下达、建应付。');
    else setMsg('已下达,推财务建应付+付款计划。');
    load();
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">🛒 大货采购(成品)</h2>
        <p className="text-xs text-gray-500 mt-1">经销单买成品:按逐款进价生成大货采购单 → 采购下达 → 财务建应付、走付款审批付供应商。无原辅料采购。</p>
      </div>

      {/* 成品款成本 */}
      <div className="rounded-xl border border-gray-200 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-xs">
            <tr>
              <th className="text-left px-3 py-2">款号</th><th className="text-left px-3 py-2">颜色</th>
              <th className="text-right px-3 py-2">数量</th><th className="text-right px-3 py-2">进价</th>
              <th className="text-right px-3 py-2">采购金额</th><th className="text-right px-3 py-2">售价</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i} className="border-t border-gray-100">
                <td className="px-3 py-2">{l.style_no || '—'}</td>
                <td className="px-3 py-2">{l.color || '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums">{l.qty.toLocaleString()}</td>
                <td className="px-3 py-2 text-right tabular-nums">{l.purchase_unit_cost != null ? money(l.purchase_unit_cost) : <span className="text-amber-600">待录进价</span>}</td>
                <td className="px-3 py-2 text-right tabular-nums font-medium">{l.purchase_unit_cost != null ? money(l.purchase_unit_cost * l.qty) : '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-400">{l.sale_unit_price != null ? money(l.sale_unit_price) : '—'}</td>
              </tr>
            ))}
            {lines.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-400">本单无成品款明细</td></tr>}
          </tbody>
          {lines.length > 0 && (
            <tfoot><tr className="border-t border-gray-200 bg-gray-50 font-semibold">
              <td className="px-3 py-2" colSpan={4}>大货采购成本合计</td>
              <td className="px-3 py-2 text-right tabular-nums" colSpan={2}>{money(data?.costTotal || 0)}</td>
            </tr></tfoot>
          )}
        </table>
      </div>
      {!hasCost && <p className="text-xs text-amber-600">⚠️ 还没录成品进价 —— 请先到订单逐款填「采购进价 + 数量」,才能生成大货采购单。</p>}

      {/* 建单(业务) */}
      {data?.canCreate && !activePo && hasCost && (
        <div className="rounded-xl border border-gray-200 p-4 space-y-3">
          <p className="text-sm font-medium text-gray-800">生成大货采购单(草稿)</p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs text-gray-600">供应商 *
              <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className="block mt-1 w-56 border rounded-lg px-2 py-1.5 text-sm">
                <option value="">选择供应商…</option>
                {(data?.suppliers || []).map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            <label className="text-xs text-gray-600">付款方式
              <input value={terms} onChange={(e) => setTerms(e.target.value)} className="block mt-1 w-32 border rounded-lg px-2 py-1.5 text-sm" placeholder="月结/预付…" />
            </label>
            <label className="text-xs text-gray-600">交期
              <input type="date" value={delivery} onChange={(e) => setDelivery(e.target.value)} className="block mt-1 w-40 border rounded-lg px-2 py-1.5 text-sm" />
            </label>
            <button onClick={createPo} disabled={busy} className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
              {busy ? '生成中…' : '生成大货采购单'}
            </button>
          </div>
        </div>
      )}

      {/* 采购单列表 */}
      {pos.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-gray-800">大货采购单</p>
          {pos.map((po: any) => {
            const st = poStatusLabel(po);
            const isDraft = po.status === 'draft' || (!po.status);
            const hasProof = Array.isArray(po.order_proof_paths) && po.order_proof_paths.length > 0;
            return (
              <div key={po.id} className="rounded-xl border border-gray-200 p-3 flex flex-wrap items-center gap-3">
                <span className="font-mono text-sm">{po.po_no}</span>
                <span className="text-sm text-gray-600">{po.supplier_name || po.suppliers?.name || '—'}</span>
                <span className="text-sm font-medium tabular-nums">{money(Number(po.total_amount) || 0)}</span>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${st.cls}`}>{st.text}</span>
                {isDraft && data?.canPlace && (
                  <div className="flex items-center gap-2 ml-auto">
                    <label className="text-xs px-2.5 py-1 rounded-lg border border-gray-300 cursor-pointer hover:bg-gray-50">
                      {hasProof ? '✓ 已传凭证·重传' : '上传下单凭证'}
                      <input type="file" className="hidden" accept="image/*,.pdf" disabled={busy}
                        onChange={(e) => { const f = e.target.files?.[0]; if (f) onProof(po.id, f); e.currentTarget.value = ''; }} />
                    </label>
                    <button onClick={() => place(po.id)} disabled={busy}
                      className="text-xs px-3 py-1.5 rounded-lg bg-green-600 text-white font-medium hover:bg-green-700 disabled:opacity-50">
                      下达(推财务建应付)
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {msg && <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">{msg}</p>}
      {err && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{err}</p>}
    </div>
  );
}
