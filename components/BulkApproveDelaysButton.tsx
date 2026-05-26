'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { bulkApproveAllPendingDelays } from '@/app/actions/delays';

interface Props {
  /** 当前显示给用户的延期数量，仅用于按钮文案 */
  pendingCount: number;
}

export function BulkApproveDelaysButton({ pendingCount }: Props) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{
    approved: number;
    failed: number;
    total: number;
    message: string;
  } | null>(null);
  const router = useRouter();

  const handleClick = () => {
    if (pendingCount === 0) return;
    const note = window.prompt(
      `即将批准所有 ${pendingCount} 条延期申请，每条都会更新里程碑日期、写日志、触发通知。\n\n请输入审批备注（可留空，默认 "批量批准（系统清理积压）"）：`,
      '',
    );
    // null = 用户点了取消
    if (note === null) return;
    setResult(null);
    startTransition(async () => {
      const res = await bulkApproveAllPendingDelays(note || undefined);
      setResult({
        approved: res.approved,
        failed: res.failed,
        total: res.total,
        message: res.message,
      });
      // 刷新列表展示最新状态
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
            : 'bg-amber-600 hover:bg-amber-700 text-white'
        }`}
      >
        {pending
          ? `批准中... (这可能需要 ${Math.ceil(pendingCount / 2)} 秒)`
          : pendingCount === 0
          ? '没有待批准的延期申请'
          : `⚡ 一键批准全部 ${pendingCount} 条延期申请`}
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
            <span className="block mt-1 text-xs">
              失败的延期申请详情请查看浏览器控制台或服务器日志。
            </span>
          )}
        </div>
      )}
    </div>
  );
}
