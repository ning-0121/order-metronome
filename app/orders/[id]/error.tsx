'use client';

import { useEffect } from 'react';

export default function OrderDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[OrderDetail Error]', error?.message, error?.digest);
  }, [error]);

  return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <div className="text-center max-w-lg px-6">
        <div className="flex items-center justify-center w-16 h-16 mx-auto mb-4 rounded-2xl bg-red-50">
          <span className="text-3xl">📦</span>
        </div>
        <h1 className="text-xl font-bold text-gray-900 mb-2">订单加载失败</h1>
        <p className="text-sm text-gray-500 mb-2">
          该订单页面出现错误，请重试或返回订单列表。
        </p>
        {error?.digest && (
          <p className="text-xs text-gray-400 mb-4 font-mono">错误 ID: {error.digest}</p>
        )}
        <div className="flex gap-3 justify-center">
          <button onClick={reset}
            className="px-5 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700">
            重试
          </button>
          <a href="/orders"
            className="px-5 py-2.5 rounded-xl border border-gray-300 bg-white text-gray-700 text-sm font-medium hover:bg-gray-50">
            返回订单列表
          </a>
        </div>
      </div>
    </div>
  );
}
