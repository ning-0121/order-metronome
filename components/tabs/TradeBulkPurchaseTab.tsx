'use client';

import { useEffect, useState } from 'react';
import { getTradeBulkData, createTradeBulkPurchaseOrder, uploadTradePoProof, saveTradeLineCosts, type TradeBulkLine, changeTradePoSupplier, requestTradePoSupplierChange, decideTradePoSupplierChange } from '@/app/actions/trade-purchase';
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
  // 改供应商(草稿单):行内下拉,选完即提交
  const [editSupplierPo, setEditSupplierPo] = useState<string | null>(null);
  const [newSupplierId, setNewSupplierId] = useState('');
  async function doChangeSupplier(poId: string) {
    if (!newSupplierId) { setErr('请选择新供应商'); return; }
    setBusy(true); setErr(''); setMsg('');
    const res = await changeTradePoSupplier(orderId, poId, newSupplierId);
    setBusy(false);
    if ((res as any).error) { setErr((res as any).error); return; }
    setMsg(`供应商已改为「${(res as any).supplierName || ''}」。`);
    setEditSupplierPo(null); setNewSupplierId('');
    load();
  }
  // 改供应商申请(已下单单):选目标供应商 + 填原因,提交后走财务审批
  const [reqSupplierPo, setReqSupplierPo] = useState<string | null>(null);
  const [reqSupplierId, setReqSupplierId] = useState('');
  const [reqReason, setReqReason] = useState('');
  async function doRequestChange(poId: string) {
    if (!reqSupplierId) { setErr('请选择目标供应商'); return; }
    if (!reqReason.trim()) { setErr('请填写改供应商原因'); return; }
    setBusy(true); setErr(''); setMsg('');
    const res = await requestTradePoSupplierChange(orderId, poId, reqSupplierId, reqReason.trim());
    setBusy(false);
    if ((res as any).error) { setErr((res as any).error); return; }
    setMsg(`已提交改供应商申请(目标「${(res as any).supplierName || ''}」),待财务审批。批准后系统才会改。`);
    setReqSupplierPo(null); setReqSupplierId(''); setReqReason('');
    load();
  }
  async function doDecideChange(poId: string, decision: 'approved' | 'rejected') {
    setBusy(true); setErr(''); setMsg('');
    const res = await decideTradePoSupplierChange(poId, decision, (decideNotes[poId] || '').trim() || undefined);
    setBusy(false);
    if ((res as any).error) { setErr((res as any).error); return; }
    if ((res as any).warning) {
      // 单头已改成功、仅执行行同步失败:当成已批准(带告警),不能让人以为失败又去重试
      setMsg(`已批准,供应商已更新。⚠️ ${(res as any).warning}`);
    } else {
      setMsg(decision === 'approved' ? '已批准,供应商已更新。若该单已付款,请核对款项归属。' : '已驳回改供应商申请。');
    }
    setDecideNotes((m) => { const n = { ...m }; delete n[poId]; return n; });
    load();
  }
  // 审批意见按 poId 隔离:同一订单多张 pending PO 时,各写各的,不串(评审 #6)
  const [decideNotes, setDecideNotes] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [terms, setTerms] = useState('月结');
  const [delivery, setDelivery] = useState('');
  const [costEdits, setCostEdits] = useState<Record<string, string>>({});   // 行内进价编辑:line.id → 输入串

  async function load() {
    setLoading(true);
    const d = await getTradeBulkData(orderId);
    setData(d);
    setCostEdits({});
    setLoading(false);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [orderId]);

  // 有效进价(编辑优先,否则库里的);采购金额实时用它算
  const effCost = (l: TradeBulkLine): number | null => {
    const e = costEdits[l.id];
    if (e !== undefined) { const n = e.trim() === '' ? null : Number(e); return n != null && Number.isFinite(n) ? n : null; }
    return l.purchase_unit_cost;
  };

  async function saveCosts() {
    const updates = Object.entries(costEdits).map(([id, v]) => ({
      id, purchase_unit_cost: v.trim() === '' ? null : Number(v),
    }));
    if (updates.length === 0) return;
    setBusy(true); setErr(''); setMsg('');
    const res = await saveTradeLineCosts(orderId, updates);
    setBusy(false);
    if (res.error) { setErr(res.error); return; }
    setMsg(`已保存 ${res.updated} 款进价。`);
    load();
  }

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
            {lines.map((l) => {
              const c = effCost(l);
              return (
              <tr key={l.id} className="border-t border-gray-100">
                <td className="px-3 py-2">{l.style_no || '—'}</td>
                <td className="px-3 py-2">{l.color || '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums">{l.qty.toLocaleString()}</td>
                <td className="px-3 py-2 text-right">
                  {data?.canCost ? (
                    <input type="number" min="0" step="0.01"
                      value={costEdits[l.id] ?? (l.purchase_unit_cost ?? '')}
                      onChange={(e) => setCostEdits((m) => ({ ...m, [l.id]: e.target.value }))}
                      className="w-24 border border-gray-300 rounded px-2 py-1 text-sm text-right tabular-nums focus:border-blue-500 outline-none"
                      placeholder="待录" />
                  ) : (l.purchase_unit_cost != null ? money(l.purchase_unit_cost) : <span className="text-gray-400">—</span>)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums font-medium">{c != null ? money(c * l.qty) : '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-400">{l.sale_unit_price != null ? money(l.sale_unit_price) : '—'}</td>
              </tr>
              );
            })}
            {lines.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-400">本单无成品款明细</td></tr>}
          </tbody>
          {lines.length > 0 && (
            <tfoot><tr className="border-t border-gray-200 bg-gray-50 font-semibold">
              <td className="px-3 py-2" colSpan={4}>大货采购成本合计</td>
              <td className="px-3 py-2 text-right tabular-nums" colSpan={2}>{money(lines.reduce((s, l) => s + ((effCost(l) || 0) * l.qty), 0))}</td>
            </tr></tfoot>
          )}
        </table>
      </div>

      {/* 行内录进价:保存按钮(有改动才出) */}
      {data?.canCost && lines.length > 0 && Object.keys(costEdits).length > 0 && (
        <div className="flex items-center gap-3">
          <button onClick={saveCosts} disabled={busy}
            className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50">
            {busy ? '保存中…' : '保存进价'}
          </button>
          <span className="text-xs text-gray-400">改了 {Object.keys(costEdits).length} 款进价,记得保存</span>
        </div>
      )}
      {data?.canCost && lines.length > 0 && !hasCost && Object.keys(costEdits).length === 0 && (
        <p className="text-xs text-amber-600">⚠️ 还没录成品进价 —— 直接在上面「进价」列填成品采购价、点「保存进价」,即可生成大货采购单。</p>
      )}
      {!data?.canCost && !hasCost && (
        <p className="text-xs text-amber-600">⚠️ 还没录成品进价 —— 进价需采购/财务角色录入(你当前角色看不到底价)。</p>
      )}

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
            // 已推给财务前置审批的草稿单:不给直改,归入申请流(财务正在审这张单,
            // 供应商一变批的对象就变了,必须让财务重新确认)。2026-08-19
            const awaitingFinance = po.approval_status === 'pending';
            const canDirectEdit = isDraft && !awaitingFinance;
            const hasProof = Array.isArray(po.order_proof_paths) && po.order_proof_paths.length > 0;
            return (
              <div key={po.id} className="rounded-xl border border-gray-200 p-3 flex flex-wrap items-center gap-3">
                <span className="font-mono text-sm">{po.po_no}</span>
                <span className="text-sm text-gray-600">{po.supplier_name || po.suppliers?.name || '—'}</span>
                <span className="text-sm font-medium tabular-nums">{money(Number(po.total_amount) || 0)}</span>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${st.cls}`}>{st.text}</span>
                {/* 草稿单:改供应商业务/采购都能直接改(¥0、未下达、无付款);上传凭证/下达仍只给采购。
                    2026-08-19 修:此前整块包在 canPlace 里,业务(建单人)看不到「改供应商」,选错没法自己修。 */}
                {canDirectEdit && (data?.canPlace || data?.canCreate) && (
                  <div className="flex items-center gap-2 ml-auto">
                    {editSupplierPo === po.id ? (
                      <span className="flex items-center gap-1.5">
                        <select value={newSupplierId} onChange={(e) => setNewSupplierId(e.target.value)}
                          className="text-xs border rounded-lg px-2 py-1.5 max-w-40">
                          <option value="">选择新供应商…</option>
                          {(data?.suppliers || []).filter((sp: any) => sp.id !== po.supplier_id).map((sp: any) => (
                            <option key={sp.id} value={sp.id}>{sp.name}</option>
                          ))}
                        </select>
                        <button onClick={() => doChangeSupplier(po.id)} disabled={busy || !newSupplierId}
                          className="text-xs px-2.5 py-1.5 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50">确认</button>
                        <button onClick={() => { setEditSupplierPo(null); setNewSupplierId(''); }} disabled={busy}
                          className="text-xs px-2 py-1.5 rounded-lg border border-gray-300 hover:bg-gray-50">取消</button>
                      </span>
                    ) : (
                      <button onClick={() => setEditSupplierPo(po.id)} disabled={busy}
                        title="草稿单(未提交财务审批)可直接改;已提交审批的单需走「申请改供应商」由财务确认"
                        className="text-xs px-2.5 py-1 rounded-lg border border-gray-300 hover:bg-gray-50">改供应商</button>
                    )}
                    {data?.canPlace && (
                      <>
                        <label className="text-xs px-2.5 py-1 rounded-lg border border-gray-300 cursor-pointer hover:bg-gray-50">
                          {hasProof ? '✓ 已传凭证·重传' : '上传下单凭证'}
                          <input type="file" className="hidden" accept="image/*,.pdf" disabled={busy}
                            onChange={(e) => { const f = e.target.files?.[0]; if (f) onProof(po.id, f); e.currentTarget.value = ''; }} />
                        </label>
                        <button onClick={() => place(po.id)} disabled={busy}
                          className="text-xs px-3 py-1.5 rounded-lg bg-green-600 text-white font-medium hover:bg-green-700 disabled:opacity-50">
                          下达(推财务建应付)
                        </button>
                      </>
                    )}
                  </div>
                )}

                {/* 已下达单:改供应商要走财务审批(2026-08-19 CEO:已付款单选错供应商也要能改) */}
                {(!isDraft || awaitingFinance) && po.status !== 'cancelled' && (
                  <div className="w-full">
                    {po.supplier_change_status === 'pending' ? (
                      <div className="mt-1 rounded-lg bg-fuchsia-50 border border-fuchsia-200 px-3 py-2 text-xs">
                        <div className="text-fuchsia-800 font-medium">
                          🔀 改供应商待财务审批:{po.supplier_name || '?'} → <b>{po.supplier_change_to_name || '?'}</b>
                        </div>
                        {po.supplier_change_reason && <div className="text-fuchsia-600 mt-0.5">原因:{po.supplier_change_reason}</div>}
                        {data?.canApproveSupplierChange && (
                          <div className="flex flex-wrap items-center gap-2 mt-2">
                            <input value={decideNotes[po.id] || ''} onChange={(e) => setDecideNotes((m) => ({ ...m, [po.id]: e.target.value }))} placeholder="审批意见(可选)"
                              className="text-xs border rounded-lg px-2 py-1.5 flex-1 min-w-40" />
                            <button onClick={() => doDecideChange(po.id, 'approved')} disabled={busy}
                              className="text-xs px-2.5 py-1.5 rounded-lg bg-green-600 text-white font-medium hover:bg-green-700 disabled:opacity-50">批准改供应商</button>
                            <button onClick={() => doDecideChange(po.id, 'rejected')} disabled={busy}
                              className="text-xs px-2.5 py-1.5 rounded-lg border border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-50">驳回</button>
                          </div>
                        )}
                        {!data?.canApproveSupplierChange && <div className="text-gray-400 mt-1">等财务/管理员审批</div>}
                      </div>
                    ) : (data?.canCreate || data?.canPlace) ? (
                      reqSupplierPo === po.id ? (
                        <div className="mt-1 rounded-lg bg-gray-50 border border-gray-200 px-3 py-2 space-y-2">
                          <div className="text-xs text-gray-500">
                            {isDraft
                              ? '该单已提交财务审批,改供应商需财务确认,系统不会立即改。'
                              : '已下达/已付款的单改供应商需财务审批,系统不会立即改。'}
                          </div>
                          <select value={reqSupplierId} onChange={(e) => setReqSupplierId(e.target.value)}
                            className="text-xs border rounded-lg px-2 py-1.5 w-full max-w-64">
                            <option value="">选择目标供应商…</option>
                            {(data?.suppliers || []).filter((sp: any) => sp.id !== po.supplier_id).map((sp: any) => (
                              <option key={sp.id} value={sp.id}>{sp.name}</option>
                            ))}
                          </select>
                          <textarea value={reqReason} onChange={(e) => setReqReason(e.target.value)} rows={2}
                            placeholder="改供应商原因(必填,例:提交时选错供应商)"
                            className="text-xs border rounded-lg px-2 py-1.5 w-full" />
                          <div className="flex items-center gap-2">
                            <button onClick={() => doRequestChange(po.id)} disabled={busy || !reqSupplierId || !reqReason.trim()}
                              className="text-xs px-2.5 py-1.5 rounded-lg bg-fuchsia-600 text-white font-medium hover:bg-fuchsia-700 disabled:opacity-50">提交申请(送财务审批)</button>
                            <button onClick={() => { setReqSupplierPo(null); setReqSupplierId(''); setReqReason(''); }} disabled={busy}
                              className="text-xs px-2 py-1.5 rounded-lg border border-gray-300 hover:bg-white">取消</button>
                          </div>
                        </div>
                      ) : (
                        <button onClick={() => { setReqSupplierPo(po.id); setReqSupplierId(''); setReqReason(''); setErr(''); setMsg(''); }} disabled={busy}
                          title={isDraft ? '该单已送财务审批,改供应商需财务确认' : '已下单的单选错供应商也能改,但要财务审批'}
                          className="mt-1 text-xs px-2.5 py-1 rounded-lg border border-fuchsia-300 text-fuchsia-700 hover:bg-fuchsia-50">🔀 申请改供应商</button>
                      )
                    ) : null}
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
