'use client';

import { useState } from 'react';
import { recalcOrderMilestones } from '@/app/actions/recalc-milestones';
import { useRouter } from 'next/navigation';

interface Props {
  orderId: string;
  orderNo: string;
}

export function RecalcButton({ orderId, orderNo }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function handleRecalc() {
    const confirmed = prompt(
      `重算排期会更新「${orderNo}」所有未完成关卡的截止日期。\n已完成的关卡不受影响。\n\n请输入订单号确认：`
    );
    if (confirmed !== orderNo) {
      if (confirmed !== null) alert('订单号不匹配，操作取消');
      return;
    }

    setLoading(true);
    setResult(null);

    const res = await recalcOrderMilestones(orderId);
    if (res.error) {
      setResult(`失败：${res.error}`);
    } else {
      setResult(`已更新 ${res.data?.updated} 个关卡`);
      router.refresh();
    }
    setLoading(false);
  }

  return (
    <div className="inline-flex items-center gap-2">
      <button
        onClick={handleRecalc}
        disabled={loading}
        className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-500 hover:bg-gray-50 disabled:opacity-50"
      >
        {loading ? '重算中...' : '🔄 重算排期'}
      </button>
      {result && <span className="text-xs text-green-600">{result}</span>}
    </div>
  );
}
