'use client';

/**
 * 重排排期横幅 — 当订单已过出厂日且未出运/送仓时，提示用户重新填写上线日期 + 生产周期
 * 仅 admin / 订单 owner 可见
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  previewReschedule,
  applyReschedule,
  type ReschedulePreviewResult,
} from '@/app/actions/reschedule-order';

interface Props {
  orderId: string;
  orderNo: string;
  factoryDate: string | null;          // ISO yyyy-mm-dd
  deliveryRequiredAt: string | null;
  isShipped: boolean;                   // 出运/送仓节点是否已完成
  canReschedule: boolean;               // 是否有权重排（admin/owner）
}

function daysOverdue(factoryDate: string | null): number {
  if (!factoryDate) return 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const fd = new Date(factoryDate);
  fd.setHours(0, 0, 0, 0);
  return Math.floor((today.getTime() - fd.getTime()) / 86400000);
}

export function RescheduleBanner({
  orderId,
  orderNo,
  factoryDate,
  deliveryRequiredAt,
  isShipped,
  canReschedule,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const overdueDays = daysOverdue(factoryDate);
  // 只在「已过出厂日 + 未出运 + 有权限」三个条件都满足时显示
  if (overdueDays <= 0 || isShipped || !canReschedule) return null;

  return (
    <>
      <div className="rounded-xl bg-red-50 border-2 border-red-300 p-4 mb-4 flex items-start gap-3">
        <span className="text-2xl">⚠️</span>
        <div className="flex-1">
          <p className="text-sm font-semibold text-red-900">
            出厂日已过 {overdueDays} 天，但货物尚未出运/送仓
          </p>
          <p className="text-xs text-red-700 mt-1">
            如果生产未按计划上线，建议重新填写上线日期 + 生产周期，重算交期是否仍能赶上客户要求。
          </p>
        </div>
        <button
          onClick={() => setOpen(true)}
          className="text-sm font-medium px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white transition-colors"
        >
          📅 调整排期
        </button>
      </div>

      {open && (
        <RescheduleDialog
          orderId={orderId}
          orderNo={orderNo}
          deliveryRequiredAt={deliveryRequiredAt}
          onClose={() => setOpen(false)}
          onApplied={() => {
            setOpen(false);
            router.refresh();
          }}
        />
      )}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════
// 弹窗：填新上线日期 + 周期 → 预览 → 应用
// ═══════════════════════════════════════════════════════════════
function RescheduleDialog({
  orderId,
  orderNo,
  deliveryRequiredAt,
  onClose,
  onApplied,
}: {
  orderId: string;
  orderNo: string;
  deliveryRequiredAt: string | null;
  onClose: () => void;
  onApplied: () => void;
}) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const [productionStart, setProductionStart] = useState(todayStr);
  const [cycleDays, setCycleDays] = useState(20);
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<ReschedulePreviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doPreview = async () => {
    setLoading(true);
    setError(null);
    setPreview(null);
    try {
      const res = await previewReschedule(orderId, productionStart, cycleDays);
      if (res.error) setError(res.error);
      else setPreview(res.data || null);
    } catch (e: any) {
      setError(e?.message || '预览失败');
    } finally {
      setLoading(false);
    }
  };

  const doApply = async () => {
    if (!preview) return;
    if (!preview.feasible) {
      const ok = confirm(`新出厂日将延误 ${Math.abs(preview.bufferDays || 0)} 天交付，确定要应用吗？\n（建议先与客户协商）`);
      if (!ok) return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await applyReschedule(orderId, productionStart, cycleDays, note);
      if (res.error) {
        setError(res.error);
      } else {
        onApplied();
      }
    } catch (e: any) {
      setError(e?.message || '应用失败');
    } finally {
      setLoading(false);
    }
  };

  // 影响节点（只看未完成且有变化的）
  const changedItems = (preview?.items || []).filter(i =>
    !['done', '已完成'].includes(i.status) && i.delta_days !== null && i.delta_days !== 0
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center pt-12 px-4 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="p-6 border-b border-gray-100">
          <h2 className="text-lg font-bold text-gray-900">调整排期 — {orderNo}</h2>
          <p className="text-xs text-gray-500 mt-1">填写实际上线日期与生产周期，预览交期影响</p>
        </div>

        <div className="p-6 space-y-4">
          {/* 输入 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                实际/计划上线日期 <span className="text-red-500">*</span>
              </label>
              <input
                type="date"
                value={productionStart}
                onChange={(e) => { setProductionStart(e.target.value); setPreview(null); }}
                className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                生产周期（天） <span className="text-red-500">*</span>
              </label>
              <input
                type="number"
                min={1}
                max={120}
                value={cycleDays}
                onChange={(e) => { setCycleDays(parseInt(e.target.value) || 0); setPreview(null); }}
                className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">备注（可选）</label>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="例如：原料延迟到货，生产推迟 8 天"
              className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>

          <button
            onClick={doPreview}
            disabled={loading || !productionStart || cycleDays < 1}
            className="w-full px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium disabled:opacity-50"
          >
            {loading ? '计算中…' : '🔍 预览影响'}
          </button>

          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {/* 预览结果 */}
          {preview && (
            <div className="rounded-lg border border-gray-200 overflow-hidden">
              <div className={`p-4 ${preview.feasible ? 'bg-green-50' : 'bg-red-50'}`}>
                <div className="flex items-center gap-2 text-sm font-semibold mb-2">
                  <span>{preview.feasible ? '✅' : '🔴'}</span>
                  <span className={preview.feasible ? 'text-green-900' : 'text-red-900'}>
                    {preview.feasibleReason}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-3 text-xs">
                  <Cell label="原出厂日" value={preview.oldFactoryDate || '—'} />
                  <Cell label="新出厂日" value={preview.newFactoryDate} highlight />
                  <Cell label="客户要求送达" value={preview.deliveryRequiredAt || '—'} />
                </div>
              </div>

              {changedItems.length > 0 && (
                <div className="p-4 max-h-60 overflow-y-auto">
                  <p className="text-xs font-semibold text-gray-700 mb-2">受影响的未完成节点（{changedItems.length}）</p>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-gray-500">
                        <th className="text-left pb-1">节点</th>
                        <th className="text-left pb-1">原日期</th>
                        <th className="text-left pb-1">新日期</th>
                        <th className="text-right pb-1">变化</th>
                      </tr>
                    </thead>
                    <tbody>
                      {changedItems.map((it) => (
                        <tr key={it.milestone_id} className="border-t border-gray-100">
                          <td className="py-1.5 text-gray-800">{it.name}</td>
                          <td className="py-1.5 text-gray-500">{it.current_due_at?.slice(0, 10) || '—'}</td>
                          <td className="py-1.5 text-gray-900 font-medium">{it.new_due_at?.slice(0, 10) || '—'}</td>
                          <td className={`py-1.5 text-right font-medium ${
                            (it.delta_days || 0) > 0 ? 'text-red-600' :
                            (it.delta_days || 0) < 0 ? 'text-green-600' : 'text-gray-400'
                          }`}>
                            {(it.delta_days || 0) > 0 ? `+${it.delta_days}` : it.delta_days} 天
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="p-6 border-t border-gray-100 flex gap-3 justify-end">
          <button
            onClick={onClose}
            disabled={loading}
            className="px-4 py-2 rounded-lg border border-gray-300 text-sm text-gray-700 hover:bg-gray-50"
          >
            取消
          </button>
          <button
            onClick={doApply}
            disabled={loading || !preview}
            className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-sm font-medium disabled:opacity-50"
          >
            {loading ? '应用中…' : '✅ 应用新排期'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Cell({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div>
      <p className="text-gray-500 mb-0.5">{label}</p>
      <p className={`font-medium ${highlight ? 'text-blue-700' : 'text-gray-900'}`}>{value}</p>
    </div>
  );
}
