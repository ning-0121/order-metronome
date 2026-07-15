'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { changeOrderPurpose } from '@/app/actions/orders';

const PURPOSE_LABEL: Record<string, string> = {
  production: '自产(标准生产)',
  trade: '经销 / 采购成品',
  consign: '委托加工 / 外发(料工厂自采)',
  sample: '样品单',
  inquiry: '询价单',
};

const CHANGEABLE = [
  { value: 'production', label: '自产(标准生产)', hint: '绮陌自采原辅料、走采购核料下单' },
  { value: 'consign', label: '委托加工 / 外发', hint: '料由工厂自采,不走采购核料(砍掉「采购下单」节点)' },
  { value: 'trade', label: '经销 / 采购成品', hint: '直接采购成品,精简流程、无原辅料核料' },
];

/**
 * 「订单用途」展示 + 改用途入口(仅财务/管理员)。
 * 改后由 server action 温和重算里程碑(保留已完成进度)。
 */
export function OrderPurposeChanger({
  orderId,
  currentPurpose,
  canEdit,
}: {
  orderId: string;
  currentPurpose: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(currentPurpose);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const cur = currentPurpose || 'production';
  const curLabel = PURPOSE_LABEL[cur] || cur;

  async function handleSave() {
    setError('');
    if (target === cur) { setError('用途未改变'); return; }
    setSaving(true);
    const res = await changeOrderPurpose(orderId, target, reason.trim() || undefined);
    setSaving(false);
    if (res.error) { setError(res.error); return; }
    setOpen(false);
    router.refresh();
  }

  return (
    <span className="inline-flex items-center gap-2">
      <span className="text-gray-900">{curLabel}</span>
      {canEdit && (
        <button
          type="button"
          onClick={() => { setTarget(cur); setReason(''); setError(''); setOpen(true); }}
          className="text-xs px-2 py-0.5 rounded-md border border-indigo-200 text-indigo-600 hover:bg-indigo-50"
          title="经销/委托单被建成了自产?在此改正,里程碑会按新用途重算"
        >
          改
        </button>
      )}

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !saving && setOpen(false)}>
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-gray-900">修改订单用途</h3>
            <p className="mt-1 text-xs text-gray-500">
              当前:<b>{curLabel}</b>。改用途会按新用途<b>重算里程碑</b>(已完成的节点保留,未完成的多余节点移除)。此操作留痕。
            </p>

            <div className="mt-4 space-y-2">
              {CHANGEABLE.map(opt => (
                <label
                  key={opt.value}
                  className={`flex items-start gap-2.5 rounded-xl border p-3 cursor-pointer ${
                    target === opt.value ? 'border-indigo-400 bg-indigo-50' : 'border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  <input
                    type="radio" name="purpose" value={opt.value} checked={target === opt.value}
                    onChange={() => setTarget(opt.value)} className="mt-0.5"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-gray-900">
                      {opt.label}{opt.value === cur && <span className="ml-1 text-xs text-gray-400">(当前)</span>}
                    </span>
                    <span className="block text-xs text-gray-500">{opt.hint}</span>
                  </span>
                </label>
              ))}
            </div>

            <textarea
              value={reason} onChange={e => setReason(e.target.value)}
              placeholder="原因(选填,如:经销单建成了自产,改正)"
              rows={2}
              className="mt-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />

            {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setOpen(false)} disabled={saving}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">
                取消
              </button>
              <button type="button" onClick={handleSave} disabled={saving || target === cur}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white font-medium hover:bg-indigo-700 disabled:opacity-50">
                {saving ? '保存中…' : '确认修改'}
              </button>
            </div>
          </div>
        </div>
      )}
    </span>
  );
}
