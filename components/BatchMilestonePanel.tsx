'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getShipmentBatches } from '@/app/actions/shipment-batches';
import { markBatchMilestoneStep } from '@/app/actions/batch-milestones';
import {
  BATCH_STEP_META,
  isBatchStepDone,
  type BatchAwareStepKey,
} from '@/lib/domain/batchAwareSteps';

interface Batch {
  id: string;
  batch_no: number;
  quantity: number;
  quantity_unit?: string;
  etd?: string | null;
  actual_ship_date?: string | null;
  bl_number?: string | null;
  vessel_name?: string | null;
  tracking_no?: string | null;
  notes?: string | null;
  status: string;
  milestone_progress?: Record<string, string | null> | null;
}

interface Props {
  orderId: string;
  stepKey: BatchAwareStepKey;
  /** 是否可编辑（admin / 节点角色匹配 / 订单 owner）*/
  canEdit: boolean;
}

/**
 * 分批出货节点的批次进度面板
 * 嵌入在 OrderTimeline 的每个 batch-aware 节点下方
 */
export function BatchMilestonePanel({ orderId, stepKey, canEdit }: Props) {
  const router = useRouter();
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyBatch, setBusyBatch] = useState<string | null>(null);
  const [shipDialog, setShipDialog] = useState<{ batch: Batch } | null>(null);
  const [shipForm, setShipForm] = useState({
    actual_ship_date: '',
    bl_number: '',
    vessel_name: '',
    tracking_no: '',
    notes: '',
  });

  const meta = BATCH_STEP_META[stepKey];
  const isShipmentExecute = stepKey === 'shipment_execute';

  useEffect(() => {
    let stale = false;
    getShipmentBatches(orderId).then((res) => {
      if (stale) return;
      setBatches((res.data as Batch[]) || []);
      setLoading(false);
    });
    return () => { stale = true; };
  }, [orderId]);

  const refresh = async () => {
    const res = await getShipmentBatches(orderId);
    setBatches((res.data as Batch[]) || []);
  };

  async function handleMark(batch: Batch, action: 'complete' | 'undo', shipMeta?: any) {
    setBusyBatch(batch.id);
    try {
      const res = await markBatchMilestoneStep(batch.id, stepKey, action, shipMeta);
      if (!res.ok) {
        alert(`操作失败：${res.error}`);
        return;
      }
      await refresh();
      if (res.autoPromoted) {
        alert(`✅ 所有 ${res.progress?.total} 批次都已完成${meta.label}，主节点已自动标完`);
        router.refresh();
      }
    } catch (e: any) {
      alert(`异常：${e?.message || '未知错误'}`);
    } finally {
      setBusyBatch(null);
    }
  }

  function openShipDialog(batch: Batch) {
    setShipForm({
      actual_ship_date: batch.actual_ship_date || new Date().toISOString().slice(0, 10),
      bl_number: batch.bl_number || '',
      vessel_name: batch.vessel_name || '',
      tracking_no: batch.tracking_no || '',
      notes: batch.notes || '',
    });
    setShipDialog({ batch });
  }

  async function confirmShipDialog() {
    if (!shipDialog) return;
    await handleMark(shipDialog.batch, 'complete', {
      actual_ship_date: shipForm.actual_ship_date || undefined,
      bl_number: shipForm.bl_number || undefined,
      vessel_name: shipForm.vessel_name || undefined,
      tracking_no: shipForm.tracking_no || undefined,
      notes: shipForm.notes || undefined,
    });
    setShipDialog(null);
  }

  if (loading) return <div className="text-xs text-gray-400 py-2">读取批次中...</div>;
  if (batches.length === 0) {
    return (
      <div className="text-xs text-gray-500 py-2">
        ⚠ 订单标记为分批出货，但还未创建批次。请到「出货」标签页创建批次后再推进此节点。
      </div>
    );
  }

  const doneCount = batches.filter(b => isBatchStepDone(b, stepKey)).length;
  const total = batches.length;
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  return (
    <div className="mt-3 rounded-lg border border-purple-200 bg-purple-50 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-purple-900">📦 分批进度 · {meta.label}</span>
          <span className="text-xs text-purple-700">{doneCount}/{total} 批</span>
        </div>
        <div className="w-24 h-1.5 bg-purple-200 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full ${pct === 100 ? 'bg-green-500' : 'bg-purple-500'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <div className="divide-y divide-purple-200">
        {batches.map((batch) => {
          const done = isBatchStepDone(batch, stepKey);
          const completedAt = isShipmentExecute
            ? batch.actual_ship_date
            : (batch.milestone_progress?.[stepKey] || null);
          return (
            <div key={batch.id} className="py-2 flex items-center justify-between gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-semibold text-purple-900">批次 #{batch.batch_no}</span>
                  <span className="text-gray-600">{batch.quantity} {batch.quantity_unit || 'pcs'}</span>
                  {batch.etd && <span className="text-gray-400">ETD: {batch.etd}</span>}
                  {done ? (
                    <span className="text-green-700 bg-green-100 px-1.5 py-0.5 rounded text-[10px] font-semibold">
                      ✓ 已完成{completedAt ? `（${String(completedAt).slice(0, 10)}）` : ''}
                    </span>
                  ) : (
                    <span className="text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded text-[10px]">待处理</span>
                  )}
                </div>
                {isShipmentExecute && done && (batch.bl_number || batch.vessel_name) && (
                  <div className="text-[11px] text-gray-500 mt-0.5">
                    {batch.bl_number && <span>BL: {batch.bl_number}</span>}
                    {batch.vessel_name && <span className="ml-2">船名: {batch.vessel_name}</span>}
                  </div>
                )}
              </div>
              {canEdit && (
                <div className="flex-shrink-0">
                  {done ? (
                    <button
                      onClick={() => handleMark(batch, 'undo')}
                      disabled={busyBatch === batch.id}
                      className="text-[11px] px-2 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                    >
                      撤销
                    </button>
                  ) : isShipmentExecute ? (
                    <button
                      onClick={() => openShipDialog(batch)}
                      disabled={busyBatch === batch.id}
                      className="text-[11px] px-2.5 py-1 rounded bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50 font-medium"
                    >
                      标记已出运
                    </button>
                  ) : (
                    <button
                      onClick={() => handleMark(batch, 'complete')}
                      disabled={busyBatch === batch.id}
                      className="text-[11px] px-2.5 py-1 rounded bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50 font-medium"
                    >
                      标完成
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="text-[11px] text-purple-700">
        💡 所有 {total} 批均完成后，主节点会自动标记为「已完成」。
      </p>

      {/* 出运对话框 — 仅 shipment_execute 用 */}
      {shipDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30" onClick={() => setShipDialog(null)}>
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md space-y-3" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-900">标记批次 #{shipDialog.batch.batch_no} 已出运</h3>
            <p className="text-xs text-gray-500">数量 {shipDialog.batch.quantity} {shipDialog.batch.quantity_unit || 'pcs'}</p>
            <div className="space-y-2">
              <div>
                <label className="text-xs font-medium text-gray-700 block mb-0.5">实际出运日</label>
                <input
                  type="date"
                  value={shipForm.actual_ship_date}
                  onChange={(e) => setShipForm({ ...shipForm, actual_ship_date: e.target.value })}
                  className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-700 block mb-0.5">提单号（BL）</label>
                <input
                  type="text"
                  value={shipForm.bl_number}
                  onChange={(e) => setShipForm({ ...shipForm, bl_number: e.target.value })}
                  placeholder="如 HLCU-1234567"
                  className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-700 block mb-0.5">船名 / 航次</label>
                <input
                  type="text"
                  value={shipForm.vessel_name}
                  onChange={(e) => setShipForm({ ...shipForm, vessel_name: e.target.value })}
                  placeholder="如 EVER GIVEN V.123E"
                  className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-700 block mb-0.5">跟踪号（可选）</label>
                <input
                  type="text"
                  value={shipForm.tracking_no}
                  onChange={(e) => setShipForm({ ...shipForm, tracking_no: e.target.value })}
                  className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-700 block mb-0.5">备注</label>
                <textarea
                  value={shipForm.notes}
                  onChange={(e) => setShipForm({ ...shipForm, notes: e.target.value })}
                  rows={2}
                  className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShipDialog(null)} className="px-4 py-2 text-sm text-gray-500 hover:bg-gray-100 rounded-lg">
                取消
              </button>
              <button onClick={confirmShipDialog} className="px-4 py-2 text-sm bg-purple-600 text-white rounded-lg hover:bg-purple-700">
                确认已出运
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
