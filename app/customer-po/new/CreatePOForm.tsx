'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { listQuotes } from '@/app/actions/quoter';
import { getApprovedQuoteForCompare } from '@/app/actions/quote-consumption';
import { createPO } from '@/app/actions/customer-po';
import { getAraosHandoffForCustomer, type AraosHandoffSummary } from '@/app/actions/araos-handoff';
import type { CompareBasis } from '@/lib/quoter/consumption';

export function CreatePOForm() {
  const searchParams = useSearchParams();
  const [quotes, setQuotes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [quoteId, setQuoteId] = useState('');
  const [poNumber, setPoNumber] = useState('');
  const [basis, setBasis] = useState<CompareBasis | null>(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [createdId, setCreatedId] = useState('');
  const [araosRef, setAraosRef] = useState<AraosHandoffSummary | null>(null);   // 该客户的 araos 中标单(建单参考)

  // 客户确定后拉 araos 中标单摘要,供建单参考(定价仍人工确认)——审计 #6:此前 inbox 无人读、业务只能切回 araos 抄录
  useEffect(() => {
    const cid = (basis?.snapshot?.header as any)?.customer_id ?? null;
    if (!cid) { setAraosRef(null); return; }
    getAraosHandoffForCustomer(cid).then((r) => setAraosRef((r as any).data || null)).catch(() => setAraosRef(null));
  }, [basis]);

  useEffect(() => {
    const preQuote = searchParams.get('quote'); // P1a:从报价详情「立即建 PO」带过来的报价
    listQuotes(100)
      .then((r) => setQuotes((r.data || []).filter((q: any) => q.approved_version != null)))
      .finally(() => {
        setLoading(false);
        if (preQuote) handleSelect(preQuote);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSelect(id: string) {
    setQuoteId(id);
    setBasis(null);
    setCreatedId('');
    if (!id) return;
    setChecking(true);
    setBasis(await getApprovedQuoteForCompare(id)); // 只读消费闸门
    setChecking(false);
  }

  const consumable = !!(basis && basis.consumable);
  const customerId = (basis?.snapshot?.header as any)?.customer_id ?? null;
  const canSubmit = consumable && !!customerId && poNumber.trim().length > 0 && !submitting;

  async function handleSubmit() {
    if (!consumable || !customerId) return;
    setSubmitting(true);
    const res = await createPO({ quoteId, customerId, poNumber: poNumber.trim() });
    setSubmitting(false);
    if (res.error) { alert('创建 PO 失败：' + res.error); return; }
    setCreatedId(res.id || '');
  }

  if (createdId) {
    return (
      <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-6">
        <p className="text-emerald-800 font-semibold mb-1">✅ 客户 PO 已创建</p>
        <p className="text-xs text-emerald-700 font-mono mb-4">customer_po.id = {createdId}</p>
        <div className="flex gap-2">
          <Link href={`/orders/new?po=${createdId}`} className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700">
            ➡️ 从此 PO 建单
          </Link>
          <button onClick={() => { setCreatedId(''); setQuoteId(''); setPoNumber(''); setBasis(null); }}
            className="px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50">
            再建一个
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* 已审批报价选择 */}
      <section className="bg-white rounded-xl border border-gray-200 p-5">
        <label className="block text-sm font-semibold text-gray-800 mb-2">
          已审批报价 <span className="text-red-500">*</span>
        </label>
        {loading ? (
          <p className="text-sm text-gray-400">加载中…</p>
        ) : quotes.length === 0 ? (
          <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-700">
            暂无已审批报价。请先到<b>报价详情页</b>的「审批 / 版本」区审批一个报价(设价格地板 → 冻结快照),再回来建 PO。
          </div>
        ) : (
          <select value={quoteId} onChange={(e) => handleSelect(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white">
            <option value="">— 选择已审批报价 —</option>
            {quotes.map((q: any) => (
              <option key={q.id} value={q.id}>
                {q.quote_no} · {q.customer_name || '（无客户名）'} · 审批版 v{q.approved_version}
              </option>
            ))}
          </select>
        )}
      </section>

      {/* 快照校验（只读） */}
      {quoteId && (
        <section className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-gray-800">冻结快照校验（只读）</h3>
            {checking ? <span className="text-xs text-gray-400">校验中…</span>
              : consumable ? <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">✅ 可消费 · 已审批</span>
              : <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700">⛔ 不可消费（{basis?.basis || '—'}）</span>}
          </div>
          {consumable ? (
            <p className="text-sm text-gray-500">
              客户：{String((basis?.snapshot?.header as any)?.customer_name ?? '—')} · 快照版 v{basis?.snapshotVersion}
              {!customerId && <span className="text-red-600"> · ⚠️ 快照缺 customer_id，无法建 PO</span>}
            </p>
          ) : (
            <p className="text-sm text-gray-500">该报价快照当前不可消费,无法建 PO(只有已审批冻结版可建)。</p>
          )}
        </section>
      )}

      {/* araos 中标单参考(建单核对款/量/交期,减少切回 araos 抄录;定价不自动带入) */}
      {araosRef && (
        <section className="bg-amber-50/60 rounded-xl border border-amber-200 p-5">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-amber-900">🏆 来自 araos 的中标单(建单参考)</h3>
            <span className="text-xs text-amber-600">{araosRef.received_at ? String(araosRef.received_at).slice(0, 10) : ''}</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1 text-xs text-gray-700">
            {araosRef.order_ref && <div><span className="text-gray-400">客户单号:</span> {araosRef.order_ref}</div>}
            {araosRef.quantity != null && <div><span className="text-gray-400">数量:</span> {araosRef.quantity}</div>}
            {araosRef.required_delivery && <div><span className="text-gray-400">要求交期:</span> {araosRef.required_delivery}</div>}
            {araosRef.order_value != null && <div><span className="text-gray-400">货值:</span> {araosRef.currency || '$'}{araosRef.order_value.toLocaleString()}</div>}
          </div>
          {araosRef.product_lines.length > 0 && (
            <div className="mt-2 text-xs">
              <div className="text-gray-400 mb-1">款 / 色 / 码 / 数量:</div>
              <div className="space-y-0.5">
                {araosRef.product_lines.map((l, i) => (
                  <div key={i} className="text-gray-700">{[l.style, l.color, l.size].filter(Boolean).join(' · ') || '—'}{l.qty != null ? ` × ${l.qty}` : ''}</div>
                ))}
              </div>
            </div>
          )}
          {araosRef.note && <div className="mt-2 text-xs text-gray-500">备注: {araosRef.note}</div>}
          <p className="mt-2 text-[11px] text-amber-700">↳ 供核对款/量/交期,减少切回 araos 抄录;成交价以本次报价快照为准,不自动带入。</p>
        </section>
      )}

      {/* PO 号 + 提交 */}
      {consumable && customerId && (
        <section className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
          <label className="block text-sm font-semibold text-gray-800">客户 PO 号 <span className="text-red-500">*</span></label>
          <input value={poNumber} onChange={(e) => setPoNumber(e.target.value)}
            placeholder="客户自己的采购单号" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          <button onClick={handleSubmit} disabled={!canSubmit}
            className="w-full py-3 rounded-xl bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50">
            {submitting ? '创建中…' : '创建客户 PO（绑定冻结快照）'}
          </button>
        </section>
      )}
    </div>
  );
}
