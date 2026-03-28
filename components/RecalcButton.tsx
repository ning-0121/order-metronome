'use client';

import { useState } from 'react';
import { recalcAllOrders } from '@/app/actions/recalc-milestones';
import { useRouter } from 'next/navigation';

export function RecalcButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function handleRecalc() {
    if (!confirm('确定重算所有未完成订单的排期？已完成的关卡不受影响。')) return;
    setLoading(true);
    setResult(null);

    const res = await recalcAllOrders();
    if (res.error) {
      setResult(`失败：${res.error}`);
    } else {
      setResult(`完成：${res.data?.total} 个订单已重算`);
      router.refresh();
    }
    setLoading(false);
  }

  return (
    <div className="inline-flex items-center gap-2">
      <button
        onClick={handleRecalc}
        disabled={loading}
        className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
      >
        {loading ? '重算中...' : '🔄 重算所有排期'}
      </button>
      {result && <span className="text-xs text-green-600">{result}</span>}
    </div>
  );
}
