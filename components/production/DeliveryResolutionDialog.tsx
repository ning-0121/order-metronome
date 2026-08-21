'use client';

/**
 * 逾期处置弹窗(2026-08-21)。CEO:「我们是来进行订单推进的,不只是停在预警上」。
 *
 * 「真超期」每行原本只有「详情›」——看得见、动不了。这个弹窗是那条红线的出口。
 *
 * 表单的必填规则与 app/actions/delivery-resolution.ts **逐条对应**:
 *   · 改期/分批 → 必须给新交期(没有新交期就不算处置,红条该继续挂着)
 *   · 快船/打折 → 必须填金额(代价要落进财务口径)
 *   · 任何处置 → 客户答复 + 理由必填(跟客户谈过要留痕,不能只有口头)
 * 前端先拦是为了少一次往返,服务端仍会再校验一遍 —— 不依赖前端做闸。
 */

import { useState } from 'react';
import { requestDeliveryResolution, type ResolutionType, type CostKind } from '@/app/actions/delivery-resolution';

const TYPES: { value: ResolutionType; label: string; desc: string }[] = [
  { value: 'reschedule', label: '客户同意改期', desc: '谈成了新交期 —— 填新出厂日/ETD' },
  { value: 'expedite', label: '快船 / 空运赶', desc: '交期不动,吃运费把货赶上' },
  { value: 'discount', label: '打折发货', desc: '让价换客户接收' },
  { value: 'partial_ship', label: '分批出货', desc: '好的先走,余量给新交期' },
  { value: 'abandon', label: '弃货 / 取消', desc: '这批不做了' },
  { value: 'other', label: '其他', desc: '在原因里说清楚' },
];
const COST_KINDS: { value: CostKind; label: string }[] = [
  { value: 'air_freight', label: '空运费' },
  { value: 'express_sea', label: '快船费' },
  { value: 'discount', label: '折让' },
  { value: 'write_off', label: '弃货损失' },
  { value: 'other', label: '其他' },
];

const NEEDS_DATE: ResolutionType[] = ['reschedule', 'partial_ship'];
const NEEDS_COST: ResolutionType[] = ['expedite', 'discount'];

export function DeliveryResolutionDialog({ orderId, orderNo, deliveryDate, onClose, onDone }: {
  orderId: string; orderNo: string; deliveryDate?: string | null;
  onClose: () => void; onDone: () => void;
}) {
  const [type, setType] = useState<ResolutionType | ''>('');
  const [newFactoryDate, setNewFactoryDate] = useState('');
  const [newEtd, setNewEtd] = useState('');
  const [customerResponse, setCustomerResponse] = useState('');
  const [customerConfirmedAt, setCustomerConfirmedAt] = useState('');
  const [costAmount, setCostAmount] = useState('');
  const [costKind, setCostKind] = useState<CostKind | ''>('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const needsDate = !!type && NEEDS_DATE.includes(type);
  const needsCost = !!type && NEEDS_COST.includes(type);

  async function submit() {
    setErr('');
    if (!type) { setErr('请先选择处置方式'); return; }
    if (!customerResponse.trim()) { setErr('请填写客户答复 —— 跟客户谈过必须留痕'); return; }
    if (!reason.trim()) { setErr('请说明为什么选这个处置'); return; }
    if (needsDate && !newFactoryDate && !newEtd) { setErr('改期/分批必须给出新的出厂日或 ETD'); return; }
    if (needsCost && !(Number(costAmount) > 0)) { setErr('快船/打折必须填写金额'); return; }
    setBusy(true);
    const res = await requestDeliveryResolution(orderId, {
      resolutionType: type,
      newFactoryDate: newFactoryDate || null,
      newEtd: newEtd || null,
      customerResponse: customerResponse.trim(),
      customerConfirmedAt: customerConfirmedAt || null,
      costAmount: costAmount ? Number(costAmount) : null,
      costKind: costKind || null,
      reason: reason.trim(),
    });
    setBusy(false);
    if ((res as any).error) { setErr((res as any).error); return; }
    onDone();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8" role="dialog" aria-modal="true">
      <div className="w-full max-w-2xl rounded-xl bg-white shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-gray-200 px-5 py-3">
          <div>
            <h3 className="text-base font-semibold text-gray-900">处置逾期 · {orderNo}</h3>
            <p className="mt-0.5 text-xs text-gray-500">
              原交期 {deliveryDate ? String(deliveryDate).slice(0, 10) : '—'}
              　·　订单经理审完再由财务确认，两级通过后交期才真正生效
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="关闭">✕</button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div>
            <label className="text-xs font-medium text-gray-700">处置方式</label>
            <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
              {TYPES.map((t) => (
                <button key={t.value} type="button" onClick={() => setType(t.value)}
                  className={`rounded-lg border px-3 py-2 text-left transition ${type === t.value
                    ? 'border-indigo-400 bg-indigo-50 ring-1 ring-indigo-200'
                    : 'border-gray-200 hover:border-indigo-300 hover:bg-gray-50'}`}>
                  <div className="text-sm font-medium text-gray-900">{t.label}</div>
                  <div className="mt-0.5 text-[11px] text-gray-500">{t.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {needsDate && (
            <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3">
              <div className="text-xs font-medium text-amber-900">新的交期承诺（必填其一）</div>
              <p className="mt-0.5 text-[11px] text-amber-700">没有新交期就不算处置，红条会继续挂着。</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <label className="text-xs text-gray-600">新出厂日
                  <input type="date" value={newFactoryDate} onChange={(e) => setNewFactoryDate(e.target.value)}
                    className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
                </label>
                <label className="text-xs text-gray-600">新 ETD
                  <input type="date" value={newEtd} onChange={(e) => setNewEtd(e.target.value)}
                    className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
                </label>
              </div>
            </div>
          )}

          {needsCost && (
            <div className="rounded-lg border border-rose-200 bg-rose-50/60 p-3">
              <div className="text-xs font-medium text-rose-900">代价（必填，进财务口径）</div>
              <p className="mt-0.5 text-[11px] text-rose-700">快船运费 / 折让金额，财务审批时要看这个数。</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <label className="text-xs text-gray-600">金额（¥）
                  <input type="number" min="0" step="0.01" value={costAmount} onChange={(e) => setCostAmount(e.target.value)}
                    placeholder="例：8600" className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
                </label>
                <label className="text-xs text-gray-600">费用类型
                  <select value={costKind} onChange={(e) => setCostKind(e.target.value as CostKind)}
                    className="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm">
                    <option value="">选择…</option>
                    {COST_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                  </select>
                </label>
              </div>
            </div>
          )}

          <div className="grid gap-2 sm:grid-cols-[2fr_1fr]">
            <label className="text-xs text-gray-600">客户答复 <span className="text-rose-500">*</span>
              <textarea value={customerResponse} onChange={(e) => setCustomerResponse(e.target.value)} rows={2}
                placeholder="客户怎么说的？例：客户同意顺延到 9/30，但要求提供新船期确认"
                className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
            </label>
            <label className="text-xs text-gray-600">客户确认日期
              <input type="date" value={customerConfirmedAt} onChange={(e) => setCustomerConfirmedAt(e.target.value)}
                className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
            </label>
          </div>

          <label className="block text-xs text-gray-600">为什么选这个处置 <span className="text-rose-500">*</span>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2}
              placeholder="例：面料染厂延误 12 天，客户档期还来得及，谈下来顺延两周不索赔"
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
          </label>

          {err && <div className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{err}</div>}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-gray-200 px-5 py-3">
          <p className="text-[11px] text-gray-400">提交后进入审批：订单经理 → 财务。批准前交期不变。</p>
          <div className="flex items-center gap-2">
            <button onClick={onClose} disabled={busy}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50">取消</button>
            <button onClick={submit} disabled={busy || !type}
              className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
              {busy ? '提交中…' : '提交处置'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
