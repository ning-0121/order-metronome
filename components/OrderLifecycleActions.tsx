'use client';

import { useState } from 'react';
import { OrderLifecycleStatus } from '@/lib/domain/types';
import { activateOrderAction, requestCancelAction, completeOrderAction } from '@/app/actions/orders';
import { useRouter } from 'next/navigation';

interface OrderLifecycleActionsProps {
  status: OrderLifecycleStatus;
  orderId: string;
  allMilestonesCompleted: boolean;
}

export function OrderLifecycleActions({
  status,
  orderId,
  allMilestonesCompleted,
}: OrderLifecycleActionsProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCancelForm, setShowCancelForm] = useState(false);
  const [cancelReasonType, setCancelReasonType] = useState('');
  const [cancelReasonDetail, setCancelReasonDetail] = useState('');

  const handleActivate = async () => {
    setLoading(true);
    setError(null);
    
    const result = await activateOrderAction(orderId);
    
    if (result.error) {
      setError(result.error);
    } else {
      router.refresh();
    }
    
    setLoading(false);
  };

  const handleRequestCancel = async () => {
    if (!cancelReasonType || !cancelReasonDetail.trim()) {
      setError('请填写取消原因类型和详情');
      return;
    }
    
    setLoading(true);
    setError(null);
    
    const result = await requestCancelAction(orderId, cancelReasonType, cancelReasonDetail);
    
    if (result.error) {
      setError(result.error);
    } else {
      setShowCancelForm(false);
      setCancelReasonType('');
      setCancelReasonDetail('');
      router.refresh();
    }
    
    setLoading(false);
  };

  const handleComplete = async () => {
    if (!allMilestonesCompleted) {
      setError('仍有未完成执行步骤，无法结案');
      return;
    }
    
    setLoading(true);
    setError(null);
    
    const result = await completeOrderAction(orderId);
    
    if (result.error) {
      setError(result.error);
    } else {
      router.refresh();
    }
    
    setLoading(false);
  };

  if (status === '草稿') {
    return (
      <div className="mb-6">
        <button
          onClick={handleActivate}
          disabled={loading}
          className="px-6 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? '激活中...' : '✅ 激活订单（进入执行）'}
        </button>
        {error && <p className="mt-2 text-red-600 text-sm">{error}</p>}
      </div>
    );
  }

  if (status === '执行中') {
    return (
      <div className="mb-6 space-y-4">
        <div className="flex gap-4">
          <button
            onClick={handleComplete}
            disabled={loading || !allMilestonesCompleted}
            className={`px-6 py-3 rounded-lg transition-colors ${
              allMilestonesCompleted
                ? 'bg-blue-600 text-white hover:bg-blue-700'
                : 'bg-gray-300 text-gray-500 cursor-not-allowed'
            } disabled:opacity-50`}
          >
            {loading ? '处理中...' : '✅ 结案（完成订单）'}
          </button>
          
          <button
            onClick={() => setShowCancelForm(!showCancelForm)}
            className="px-6 py-3 bg-orange-600 text-white rounded-lg hover:bg-orange-700 transition-colors"
          >
            申请取消订单
          </button>
        </div>
        
        {!allMilestonesCompleted && (
          <p className="text-sm text-gray-600">
            仍有未完成执行步骤，无法结案
          </p>
        )}
        
        {showCancelForm && (
          <div className="p-4 border border-gray-200 rounded-lg bg-gray-50">
            <h3 className="font-semibold mb-3">申请取消订单</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium mb-1">取消原因类型</label>
                <select
                  value={cancelReasonType}
                  onChange={(e) => setCancelReasonType(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                >
                  <option value="">请选择</option>
                  <option value="customer_cancel">客户取消</option>
                  <option value="pricing_issue">价格问题</option>
                  <option value="capacity_issue">产能问题</option>
                  <option value="risk_control">风险控制</option>
                  <option value="other">其他</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">取消原因详情（必填）</label>
                <textarea
                  value={cancelReasonDetail}
                  onChange={(e) => setCancelReasonDetail(e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  placeholder="请详细说明取消原因..."
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleRequestCancel}
                  disabled={loading}
                  className="px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 disabled:opacity-50"
                >
                  {loading ? '提交中...' : '提交申请'}
                </button>
                <button
                  onClick={() => {
                    setShowCancelForm(false);
                    setCancelReasonType('');
                    setCancelReasonDetail('');
                    setError(null);
                  }}
                  className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300"
                >
                  取消
                </button>
              </div>
            </div>
          </div>
        )}
        
        {error && <p className="text-red-600 text-sm">{error}</p>}
      </div>
    );
  }

  return null;
}
