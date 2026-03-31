'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  orderId: string;
  orderNo: string;
  lifecycleStatus: string;
  isAdmin: boolean;
  isOrderOwner: boolean;
}

export function OrderActions({ orderId, orderNo, lifecycleStatus, isAdmin, isOrderOwner }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [showCancelForm, setShowCancelForm] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelType, setCancelType] = useState('customer');

  const isDraft = lifecycleStatus === 'draft';
  const canActivate = isDraft && (isOrderOwner || isAdmin);
  const canDelete = isDraft && (isAdmin || isOrderOwner);
  const canCancel = !isDraft && lifecycleStatus !== 'cancelled' && lifecycleStatus !== 'completed' && (isAdmin || isOrderOwner);

  async function handleActivate() {
    if (!confirm(`确认启动订单 ${orderNo}？启动后将进入执行状态。`)) return;
    setLoading(true);
    try {
      const { activateOrderAction } = await import('@/app/actions/orders');
      const result = await activateOrderAction(orderId);
      if (result.error) {
        alert(result.error);
      } else {
        router.refresh();
      }
    } catch {
      alert('启动失败');
    }
    setLoading(false);
  }

  async function handleDelete() {
    const input = prompt(`确定删除订单？此操作不可恢复！\n\n请输入订单号 ${orderNo} 确认删除：`);
    if (!input || input.trim() !== orderNo) {
      if (input !== null) alert('订单号输入不正确，删除已取消');
      return;
    }
    setLoading(true);

    try {
      const res = await fetch(`/api/orders/${orderId}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.error) {
        alert(json.error);
      } else {
        router.push('/orders');
        router.refresh();
      }
    } catch {
      alert('删除失败');
    }
    setLoading(false);
  }

  async function handleCancel() {
    if (!cancelReason.trim()) { alert('请填写取消原因'); return; }
    setLoading(true);

    try {
      const { requestCancelAction } = await import('@/app/actions/orders');
      const result = await requestCancelAction(orderId, cancelType, cancelReason.trim());
      if (result.error) {
        alert(result.error);
      } else {
        setShowCancelForm(false);
        setCancelReason('');
        router.refresh();
        alert('取消申请已提交，等待管理员审批');
      }
    } catch {
      alert('提交失败');
    }
    setLoading(false);
  }

  if (!canActivate && !canDelete && !canCancel) return null;

  return (
    <div className="flex items-center gap-2">
      {/* 确认启动订单 */}
      {canActivate && (
        <button
          onClick={handleActivate}
          disabled={loading}
          className="text-xs px-3 py-1.5 rounded-lg bg-green-600 text-white hover:bg-green-700 font-medium disabled:opacity-50"
        >
          确认订单
        </button>
      )}

      {/* 删除草稿 */}
      {canDelete && (
        <button
          onClick={handleDelete}
          disabled={loading}
          className="text-xs px-3 py-1.5 rounded-lg border border-red-200 text-red-500 hover:bg-red-50 disabled:opacity-50"
        >
          删除订单
        </button>
      )}

      {/* 申请取消 */}
      {canCancel && !showCancelForm && (
        <button
          onClick={() => setShowCancelForm(true)}
          className="text-xs px-3 py-1.5 rounded-lg border border-orange-200 text-orange-600 hover:bg-orange-50"
        >
          申请取消
        </button>
      )}

      {/* 取消表单 */}
      {showCancelForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setShowCancelForm(false)}>
          <div className="absolute inset-0 bg-black/30" />
          <div className="relative bg-white rounded-xl shadow-xl p-6 w-full max-w-md space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-900">申请取消订单</h3>
            <p className="text-sm text-gray-500">订单 {orderNo}</p>

            <div>
              <label className="text-sm font-medium text-gray-700">取消原因类型</label>
              <select
                value={cancelType}
                onChange={e => setCancelType(e.target.value)}
                className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
              >
                <option value="customer">客户原因</option>
                <option value="internal">内部原因</option>
                <option value="quality">品质问题</option>
                <option value="other">其他</option>
              </select>
            </div>

            <div>
              <label className="text-sm font-medium text-gray-700">详细说明</label>
              <textarea
                value={cancelReason}
                onChange={e => setCancelReason(e.target.value)}
                placeholder="请说明取消原因..."
                rows={3}
                className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
              />
            </div>

            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowCancelForm(false)} className="px-4 py-2 text-sm text-gray-500 hover:bg-gray-100 rounded-lg">
                取消
              </button>
              <button
                onClick={handleCancel}
                disabled={loading || !cancelReason.trim()}
                className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
              >
                {loading ? '提交中...' : '确认取消'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
