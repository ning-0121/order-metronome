'use client';

/**
 * PO → Order 表单（Order Intake · PO 主路径）
 *
 * 纯呈现层：PO 选择 → 只读快照预览 → 审批态渲染 → 运营信息(模板/客户上次订单预填,可改) → 提交 createOrderFromPO。
 * UI 不算价、不校验业务、不改快照、不越权 —— 审批/快照真相全来自后端只读 action。
 * P1b:运营字段补全到与 legacy 对等 + 订单模板 + 客户上次订单预填(不靠 AI,人可覆盖)。
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { listCustomerPOsForIntake, type IntakePoRow } from '@/app/actions/order-intake-read';
import { getApprovedQuoteForCompare } from '@/app/actions/quote-consumption';
import { createOrderFromPO, getCustomerOrderDefaults } from '@/app/actions/order-from-po';
import { getActiveOrderTemplates } from '@/app/actions/order-templates';
import type { CompareBasis } from '@/lib/quoter/consumption';

const ORDER_TYPES: [string, string][] = [['trial', '新品试单'], ['bulk', '正常'], ['repeat', '翻单'], ['urgent', '加急订单']];
const INCOTERMS: [string, string][] = [['DDP', 'DDP（完税后交货）'], ['FOB', 'FOB（离岸价）'], ['RMB_INC_TAX', '人民币含税'], ['RMB_EX_TAX', '人民币不含税']];
const DELIVERY_TYPES: [string, string][] = [['export', '出口（DDP，含订舱/报关/出运）'], ['domestic', '送仓（国内）']];
const AQL_OPTS: [string, string][] = [['', '— 未指定（建议按 PO 条款）—'], ['1.5', 'AQL 1.5（严格）'], ['2.5', 'AQL 2.5（标准，最常用）'], ['4.0', 'AQL 4.0（宽松）'], ['customer_specified', '客户指定其他']];
const SAMPLE_PHASES: [string, string][] = [['confirmed', '头样已确认 — 直接安排产前样'], ['dev_sample', '需要做头样 — 头样确认后再做产前样'], ['dev_sample_with_revision', '需要做头样 + 可能二次样'], ['skip_all', '不需要产前样 — 翻单/老款直接大货']];
const RISK_FLAGS: [string, string][] = [['has_plus_size', '大码款'], ['high_stretch', '高弹面料'], ['light_color_risk', '浅色风险'], ['color_clash_risk', '撞色风险'], ['complex_print', '复杂印花'], ['tight_deadline', '交期紧急']];

type Op = {
  internal_order_no: string; order_type: string; incoterm: string; delivery_type: string;
  factory_name: string; factory_id: string; factory_date: string; warehouse_due_date: string;
  sample_phase: string; aql_standard: string; shipping_sample_required: boolean; shipping_sample_deadline: string;
  risk_flags: string[];
};

export function POOrderForm({ initialPoId }: { initialPoId?: string }) {
  const router = useRouter();
  const [pos, setPos] = useState<IntakePoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState('');
  const [basis, setBasis] = useState<CompareBasis | null>(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [templates, setTemplates] = useState<any[]>([]);
  const [tplId, setTplId] = useState('');
  const [prefillMsg, setPrefillMsg] = useState('');
  // Order 自有运营字段（PO/快照不拥有 —— Contract §三）
  const [op, setOp] = useState<Op>({
    internal_order_no: '', order_type: '', incoterm: 'DDP', delivery_type: 'export',
    factory_name: '', factory_id: '', factory_date: '', warehouse_due_date: '',
    sample_phase: 'confirmed', aql_standard: '', shipping_sample_required: false, shipping_sample_deadline: '',
    risk_flags: [],
  });

  useEffect(() => {
    getActiveOrderTemplates().then((r) => setTemplates(r.data || []));
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
  const setF = (k: keyof Op, v: any) => setOp((prev) => ({ ...prev, [k]: v }));

  async function handleSelect(id: string, list: IntakePoRow[] = pos) {
    setSelectedId(id);
    setBasis(null);
    setPrefillMsg('');
    const po = list.find((p) => p.id === id);
    if (!po) return;
    setChecking(true);
    const b = await getApprovedQuoteForCompare(po.quote_id); // 只读消费闸门
    setBasis(b);
    setChecking(false);
    // P1b:按该客户上次订单预填运营字段（不靠 AI,可覆盖）
    const custId = (b?.snapshot?.header as any)?.customer_id;
    if (b?.consumable && custId) {
      const { data } = await getCustomerOrderDefaults(custId);
      if (data) {
        setOp((prev) => ({
          ...prev,
          order_type: prev.order_type || data.order_type || '',
          incoterm: data.incoterm || prev.incoterm,
          delivery_type: data.delivery_type || prev.delivery_type,
          factory_name: prev.factory_name || data.factory_name || '',
          factory_id: prev.factory_id || data.factory_id || '',
          aql_standard: prev.aql_standard || data.aql_standard || '',
          sample_phase: data.sample_phase || prev.sample_phase,
        }));
        setPrefillMsg('已按该客户上次订单预填运营字段（可改）');
      }
    }
  }

  function applyTemplate(id: string) {
    setTplId(id);
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    setOp((prev) => ({
      ...prev,
      incoterm: t.incoterm || prev.incoterm,
      delivery_type: t.incoterm === 'DDP' ? 'export' : (t.delivery_type || prev.delivery_type),
      order_type: t.order_type || prev.order_type,
      sample_phase: t.sample_phase || prev.sample_phase,
      shipping_sample_required: t.shipping_sample_required ?? prev.shipping_sample_required,
      risk_flags: Array.from(new Set([...(prev.risk_flags || []), ...(t.risk_flags || [])])),
    }));
    setPrefillMsg(`已套用模板「${t.name}」（可改）`);
  }

  const toggleRisk = (k: string) =>
    setOp((prev) => ({ ...prev, risk_flags: prev.risk_flags.includes(k) ? prev.risk_flags.filter((x) => x !== k) : [...prev.risk_flags, k] }));

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
  const inputCls = 'rounded-lg border border-gray-300 px-3 py-2 text-sm';

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
        <section className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-gray-800">订单运营信息（Order 自填，非客户数据）</h3>
            {templates.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-400">📋 模板</span>
                <select value={tplId} onChange={(e) => applyTemplate(e.target.value)}
                  className="rounded-lg border border-gray-300 px-2 py-1.5 text-xs bg-white">
                  <option value="">— 套用订单模板（可选）—</option>
                  {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
            )}
          </div>
          {prefillMsg && <p className="text-[11px] text-emerald-600">💡 {prefillMsg}</p>}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-xs text-gray-500">内部订单号 *
              <input value={op.internal_order_no} onChange={(e) => setF('internal_order_no', e.target.value)}
                placeholder="内部订单号" className={`mt-1 w-full ${inputCls}`} />
            </label>
            <label className="text-xs text-gray-500">订单类型 *
              <select value={op.order_type} onChange={(e) => setF('order_type', e.target.value)} className={`mt-1 w-full bg-white ${inputCls}`}>
                <option value="">— 请选择 —</option>
                {ORDER_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <label className="text-xs text-gray-500">贸易条款
              <select value={op.incoterm} onChange={(e) => setF('incoterm', e.target.value)} className={`mt-1 w-full bg-white ${inputCls}`}>
                {INCOTERMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <label className="text-xs text-gray-500">交付方式
              <select value={op.delivery_type} onChange={(e) => setF('delivery_type', e.target.value)} className={`mt-1 w-full bg-white ${inputCls}`}>
                {DELIVERY_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <label className="text-xs text-gray-500">工厂
              <input value={op.factory_name} onChange={(e) => setF('factory_name', e.target.value)}
                placeholder="工厂名称" className={`mt-1 w-full ${inputCls}`} />
            </label>
            <label className="text-xs text-gray-500">出厂日期 *
              <input type="date" value={op.factory_date} onChange={(e) => setF('factory_date', e.target.value)} className={`mt-1 w-full ${inputCls}`} />
            </label>
            <label className="text-xs text-gray-500">仓库交期
              <input type="date" value={op.warehouse_due_date} onChange={(e) => setF('warehouse_due_date', e.target.value)} className={`mt-1 w-full ${inputCls}`} />
            </label>
            <label className="text-xs text-gray-500">AQL 验货标准
              <select value={op.aql_standard} onChange={(e) => setF('aql_standard', e.target.value)} className={`mt-1 w-full bg-white ${inputCls}`}>
                {AQL_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <label className="text-xs text-gray-500 sm:col-span-2">样品阶段
              <select value={op.sample_phase} onChange={(e) => setF('sample_phase', e.target.value)} className={`mt-1 w-full bg-white ${inputCls}`}>
                {SAMPLE_PHASES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
          </div>

          {/* 风险标记 */}
          <div>
            <div className="text-xs text-gray-500 mb-1.5">风险标记（勾选后系统加强对应关卡管控）</div>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {RISK_FLAGS.map(([k, l]) => (
                <label key={k} className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
                  <input type="checkbox" checked={op.risk_flags.includes(k)} onChange={() => toggleRisk(k)} /> {l}
                </label>
              ))}
            </div>
          </div>

          {/* Shipping Sample */}
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
              <input type="checkbox" checked={op.shipping_sample_required} onChange={(e) => setF('shipping_sample_required', e.target.checked)} /> 需要 Shipping Sample
            </label>
            {op.shipping_sample_required && (
              <input type="date" value={op.shipping_sample_deadline} onChange={(e) => setF('shipping_sample_deadline', e.target.value)}
                className={inputCls} title="Shipping Sample 截止日" />
            )}
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
