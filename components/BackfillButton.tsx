'use client';

import { useState } from 'react';
import { backfillAllOrders } from '@/app/actions/backfill-milestones';

export function BackfillButton() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);

  const handleBackfill = async () => {
    if (!confirm('将为所有订单补齐缺失的执行节点，是否继续？')) {
      return;
    }

    setLoading(true);
    setResult(null);

    try {
      const response = await backfillAllOrders();
      setResult(response);
    } catch (error: any) {
      setResult({ error: error.message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
      <h3 className="text-lg font-semibold text-gray-900 mb-2">订单节点补齐</h3>
      <p className="text-sm text-gray-600 mb-3">
        为已有订单补齐缺失的执行节点（少于18个的订单）
      </p>
      <button
        onClick={handleBackfill}
        disabled={loading}
        className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
      >
        {loading ? '补齐中...' : '一键补齐所有订单节点'}
      </button>
      {result && (
        <div className="mt-3 p-3 bg-white rounded border">
          {result.error ? (
            <p className="text-red-600 text-sm">错误: {result.error}</p>
          ) : (
            <div className="text-sm text-gray-700">
              <p><strong>总计:</strong> {result.data?.total}</p>
              <p><strong>成功:</strong> {result.data?.success}</p>
              <p><strong>错误:</strong> {result.data?.errors}</p>
              <p><strong>跳过:</strong> {result.data?.skipped}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
