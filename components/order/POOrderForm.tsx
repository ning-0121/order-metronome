'use client';

/**
 * PO → Order 表单（Order Intake · PO 主路径）
 *
 * 纯呈现层：PO 选择 → 只读快照预览 → 审批态渲染 → 提交 createOrderFromPO。
 * UI 不算价、不校验业务、不改快照、不越权 —— 审批/快照真相全来自后端只读 action。
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { listCustomerPOsForIntake, type IntakePoRow } from '@/app/actions/order-intake-read';
import { getApprovedQuoteForCompare } from '@/app/actions/quote-consumption';
import { createOrderFromPO } from '@/app/actions/order-from-po';
import type { CompareBasis } from '@/lib/quoter/consumption';

export function POOrderForm({ initialPoId }: { initialPoId?: string }) {
  const router = useRouter();
  const [pos, setPos] = useState<IntakePoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState('');
  const [basis, setBasis] = useState<CompareBasis | null>(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Order 自有运营字段（PO/快照不拥有 —— Contract §三）
  const [op, setOp] = useState({ internal_order_no: '', incoterm: 'DDP', order_type: '', factory_date: '' });

  useEffect(() => {
    listCustomerPOsForIntake()
      .then((r) => {
        const list = r.data || [];
        setPos(list);
        // P1a:从 PO 页带 ?po= 过来 → 自动预选并跑校验（用刚拿到的 list,避开 state 异步）
        if (initialPoId && list.some((p) => p.id === initialPoId)) handleSelect(initialPoId, list);
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedPo = pos.find((p) => p.id === selectedId) || null;

  async function handleSelect(id: string, list: IntakePoRow[] = pos) {
    setSelectedId(id);
    setBasis(null);
    const po = list.find((p) => p.id === id);
    if (!po) return;
    setChecking(true);
    const b = await getApprovedQuoteForCompare(po.quote_id); // 只读消费闸门
    setBasis(b);
    setChecking(false);
  }

  // 审批态：consumable + 版本匹配 = 允许
  const approved = !!(basis && selectedPo && basis.consumable && basis.snapshotVersion === selectedPo.quote_snapshot_version);
  const canSubmit = approved && op.internal_order_no.trim() && op.order_type && op.factory_date && !submitting;

  async function handleSubmit() {
    if (!selectedPo) return;
    setSubmitting(true);
    const res = await createOrderFromPO({ customerPoId: selectedPo.id, operational: op });
    setSubmitting(false);
    if (!res.ok) { alert('建单失败：' + (res.error || '未知')); return; }
    alert('✅ 已从 PO 生成订单');
    router.push(`/orders/${res.orderId}`);
  }

  const snap: any = basis?.snapshot ?? null;
  const lines: any[] = (snap?.lines as any[]) || [];

  return (
    <div className="space-y-5">
      {/* PO 选择器 */}
      <section className="bg-white rounded-xl border border-gray-200 p-5">
        <label className="block text-sm font-semibold text-gray-800 mb-2">
          客户 PO <span className="text-red-500">*</span>
        </label>
        {loading ? (
          <p className="text-sm text-gray-400">加载 PO 列表…</p>
        ) : pos.length === 0 ? (
          <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-700">
            暂无客户 PO。请先在 PO 系统创建（PO 由已审批报价生成）。
          </div>
        ) : (
          <select
            value={selectedId}
            onChange={(e) => handleSelect(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white"
          >
            <option value="">— 选择客户 PO —</option>
            {pos.map((p) => (
              <option key={p.id} value={p.id}>
                {p.po_number} · v{p.quote_snapshot_version} · {p.status}
              </option>
            ))}
          </select>
        )}
      </section>

      {/* 快照预览（只读）+ 审批态 */}
      {selectedPo && (
        <section className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-800">报价快照（只读）</h3>
            {checking ? (
              <span className="text-xs text-gray-400">校验中…</span>
            ) : approved ? (
              <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">✅ 已审批 · 可建单</span>
            ) : (
              <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700">
                ⛔ 未审批 / 不可消费（{basis?.basis || '—'}）
              </span>
            )}
          </div>

          {!approved ? (
            <p className="text-sm text-gray-500">
              该 PO 绑定的快照当前不可消费（basis={basis?.basis || '—'}）。订单只能由 <b>已审批冻结快照</b> 派生。
            </p>
          ) : (
            <div className="space-y-2 text-sm">
              <div className="text-gray-500">
                客户：{String(snap?.header?.customer_name ?? '—')} · 币种：{String(snap?.header?.currency ?? '—')} · 快照版 v{basis?.snapshotVersion}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-gray-50 text-left text-gray-500">
                      <th className="px-3 py-2">#</th><th className="px-3 py-2">款号</th>
                      <th className="px-3 py-2 text-center">数量</th><th className="px-3 py-2 text-right">报价/件</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {lines.map((l, i) => (
                      <tr key={l?.id || i}>
                        <td className="px-3 py-1.5 text-gray-400">{l?.line_no ?? i + 1}</td>
                        <td className="px-3 py-1.5">{l?.style_no || '—'}</td>
                        <td className="px-3 py-1.5 text-center">{l?.quantity ?? 0}</td>
                        <td className="px-3 py-1.5 text-right font-mono">{l?.quoted_price_per_piece ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-gray-400">↑ 继承值只读，订单不重算（价格来自不可变快照）。</p>
            </div>
          )}
        </section>
      )}

      {/* Order 自有运营字段 + 提交 */}
      {approved && (
        <section className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
          <h3 className="text-sm font-semibold text-gray-800">订单运营信息（Order 自填，非客户数据）</h3>
          <div className="grid grid-cols-2 gap-3">
            <input value={op.internal_order_no} onChange={(e) => setOp({ ...op, internal_order_no: e.target.value })}
              placeholder="内部订单号 *" className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            <input value={op.order_type} onChange={(e) => setOp({ ...op, order_type: e.target.value })}
              placeholder="订单类型 *（如 export）" className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            <select value={op.incoterm} onChange={(e) => setOp({ ...op, incoterm: e.target.value })}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white">
              <option value="DDP">DDP</option><option value="FOB">FOB</option>
              <option value="RMB_INC_TAX">RMB 含税</option><option value="RMB_EX_TAX">RMB 不含税</option>
            </select>
            <input type="date" value={op.factory_date} onChange={(e) => setOp({ ...op, factory_date: e.target.value })}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
          <button onClick={handleSubmit} disabled={!canSubmit}
            className="w-full py-3 rounded-xl bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50">
            {submitting ? '生成中…' : '📦 从 PO 生成订单'}
          </button>
        </section>
      )}
    </div>
  );
}
