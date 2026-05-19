'use client';

/**
 * 「交期已过」订单状态确认 Modal
 *
 * 业务场景：创建订单时填写的 ETD / 出厂日 / 到仓日 已经是过去的日期，
 * 系统不知道该订单是「补录历史」还是「真在做没及时录」。需要业务明确选：
 *   - shipped: 已发货（补录历史数据）
 *   - pending: 未发货，在途中
 *   - problem: 未发货，有问题（必须填原因）
 *
 * 为什么不用浏览器 prompt：
 *   Mobile Safari / 频繁触发后的 Chrome 会静默 block window.prompt，
 *   返回 null。业务以为提交了，实际啥也没发生 — 这是「点不动」类静默
 *   故障的高发场景。改用 React state 驱动的 modal，行为可控可测。
 */

import { useState } from 'react';

export type PastDateStatus = 'shipped' | 'pending' | 'problem';

interface Props {
  open: boolean;
  deliveryDate: string;
  onConfirm: (status: PastDateStatus, reason?: string) => void;
  onCancel: () => void;
}

const OPTIONS: { value: PastDateStatus; label: string; desc: string; color: string }[] = [
  { value: 'shipped', label: '已发货（补录历史）', desc: '货已经出了，现在补录到系统', color: 'bg-green-50 border-green-300 text-green-900 hover:bg-green-100' },
  { value: 'pending', label: '未发货，在途中', desc: '订单仍在执行，只是逾期了', color: 'bg-blue-50 border-blue-300 text-blue-900 hover:bg-blue-100' },
  { value: 'problem', label: '未发货，有问题', desc: '客户暂停、面料问题、品质返工等', color: 'bg-amber-50 border-amber-300 text-amber-900 hover:bg-amber-100' },
];

export function PastDateStatusModal({ open, deliveryDate, onConfirm, onCancel }: Props) {
  const [selected, setSelected] = useState<PastDateStatus | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  if (!open) return null;

  function handleConfirm() {
    if (!selected) {
      setError('请先选择一个状态');
      return;
    }
    if (selected === 'problem' && !reason.trim()) {
      setError('选择「未发货，有问题」时必须填写原因');
      return;
    }
    onConfirm(selected, selected === 'problem' ? reason.trim() : undefined);
    // 重置（下次打开是干净状态）
    setSelected(null);
    setReason('');
    setError('');
  }

  function handleCancel() {
    setSelected(null);
    setReason('');
    setError('');
    onCancel();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-black/60" onClick={handleCancel} />
      <div className="relative bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full sm:max-w-md max-h-[90vh] overflow-y-auto">
        <div className="p-5 sm:p-6">
          <div className="flex items-start gap-3 mb-4">
            <span className="text-3xl">⚠️</span>
            <div className="flex-1 min-w-0">
              <h2 className="text-lg font-semibold text-gray-900">交期 {deliveryDate} 已过</h2>
              <p className="text-sm text-gray-600 mt-0.5">请选择订单的实际状态</p>
            </div>
          </div>

          <div className="space-y-2">
            {OPTIONS.map(opt => (
              <button
                key={opt.value}
                type="button"
                onClick={() => { setSelected(opt.value); setError(''); }}
                className={`w-full text-left px-4 py-3 rounded-lg border-2 transition-colors ${
                  selected === opt.value
                    ? opt.color + ' border-current'
                    : 'border-gray-200 bg-white text-gray-800 hover:border-gray-300'
                }`}
              >
                <div className="font-medium text-sm">{opt.label}</div>
                <div className="text-xs text-gray-500 mt-0.5">{opt.desc}</div>
              </button>
            ))}
          </div>

          {selected === 'problem' && (
            <div className="mt-4">
              <label className="block text-xs font-medium text-gray-700 mb-1">
                未发货原因 <span className="text-red-500">*</span>
              </label>
              <textarea
                value={reason}
                onChange={e => { setReason(e.target.value); if (e.target.value.trim()) setError(''); }}
                rows={3}
                placeholder="如：客户暂停、面料问题、品质返工等"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
                autoFocus
              />
            </div>
          )}

          {error && (
            <p className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
              {error}
            </p>
          )}

          <div className="mt-5 flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
            <button
              type="button"
              onClick={handleCancel}
              className="px-4 py-2.5 rounded-lg border border-gray-300 bg-white text-sm text-gray-700 hover:bg-gray-50"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={!selected}
              className="px-5 py-2.5 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50"
            >
              确认继续创建
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
