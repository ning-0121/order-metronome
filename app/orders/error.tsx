'use client';

import { useEffect } from 'react';

/**
 * 订单列表页错误兜底（Sprint 0 加固）
 *
 * 触发：app/orders/page.tsx SSR 异常时降级到此页，避免整站 500。
 * 不暴露 stack；仅显示友好提示 + digest（错误 ID）+ 操作入口。
 */
export default function OrdersError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[Orders Error]', error?.message, error?.digest);
  }, [error]);

  return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <div className="text-center max-w-lg px-6">
        <div className="flex items-center justify-center w-16 h-16 mx-auto mb-4 rounded-2xl bg-red-50">
          <span className="text-3xl">📦</span>
        </div>
        <h1 className="text-xl font-bold text-gray-900 mb-2">订单列表加载失败</h1>
        <p className="text-sm text-gray-500 mb-2">
          很抱歉，订单数据加载出现问题。可以尝试重试，或回到工作台。
        </p>
        {error?.digest && (
          <p className="text-xs text-gray-400 mb-4 font-mono">错误 ID: {error.digest}</p>
        )}
        <div className="flex gap-3 justify-center">
          <button
            onClick={reset}
            className="px-5 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700"
          >
            重试
          </button>
          <a
            href="/dashboard"
            className="px-5 py-2.5 rounded-xl border border-gray-300 bg-white text-gray-700 text-sm font-medium hover:bg-gray-50"
          >
            去工作台
          </a>
        </div>
      </div>
    </div>
  );
}
