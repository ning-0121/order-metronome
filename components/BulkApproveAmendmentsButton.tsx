'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { bulkApproveAllPendingAmendments } from '@/app/actions/order-amendments';

interface Props {
  /** 当前待处理的订单修改申请数量，仅用于按钮文案 */
  pendingCount: number;
}

export function BulkApproveAmendmentsButton({ pendingCount }: Props) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ approved: number; failed: number; total: number; message: string } | null>(null);
  const router = useRouter();

  const handleClick = () => {
    if (pendingCount === 0) return;
    const note = window.prompt(
      `即将批准所有 ${pendingCount} 条订单修改申请，每条都会应用改动、写日志、同步财务/通知。\n提交后订单已推进关键节点的会被自动驳回(窗口已关)。\n\n请输入审批备注（可留空，默认「批量批准（清理积压）」）：`,
      '',
    );
    if (note === null) return; // 取消
    setResult(null);
    startTransition(async () => {
      const res = await bulkApproveAllPendingAmendments(note || undefined);
      setResult({ approved: res.approved, failed: res.failed, total: res.total, message: res.message });
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col gap-2 mb-3">
      <button
        onClick={handleClick}
        disabled={pending || pendingCount === 0}
        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors w-fit ${
          pending || pendingCount === 0
            ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
            : 'bg-violet-600 hover:bg-violet-700 text-white'
        }`}
      >
        {pending
          ? `批准中... (约 ${Math.ceil(pendingCount / 2)} 秒)`
          : pendingCount === 0
          ? '没有待批准的订单修改申请'
          : `⚡ 一键批准全部 ${pendingCount} 条订单修改申请`}
      </button>
      {result && (
        <div
          className={`p-3 rounded-lg text-sm ${
            result.failed > 0
              ? 'bg-amber-50 border border-amber-200 text-amber-800'
              : 'bg-green-50 border border-green-200 text-green-800'
          }`}
        >
          ✓ {result.message}
          {result.failed > 0 && (
            <span className="block mt-1 text-xs">未通过的申请仍留在列表，可单条「前往处理」查看原因。</span>
          )}
        </div>
      )}
    </div>
  );
}
