'use client';

import { useEffect } from 'react';

/**
 * 根级错误边界 — 所有页面的通用 fallback
 * 当子页面没有自己的 error.tsx 时，由这个兜底
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[RootError]', error?.message, error?.digest);
  }, [error]);

  return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <div className="text-center max-w-lg px-6">
        <div className="flex items-center justify-center w-16 h-16 mx-auto mb-4 rounded-2xl bg-red-50">
          <span className="text-3xl">⚠</span>
        </div>
        <h1 className="text-xl font-bold text-gray-900 mb-2">页面加载失败</h1>
        <p className="text-sm text-gray-500 mb-2">
          系统遇到了一个错误，请尝试刷新页面。
        </p>
        {error?.digest && (
          <p className="text-xs text-gray-400 mb-4 font-mono">
            错误 ID: {error.digest}
          </p>
        )}
        <div className="flex gap-3 justify-center">
          <button
            onClick={reset}
            className="px-5 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors"
          >
            重试
          </button>
          <a
            href="/"
            className="px-5 py-2.5 rounded-xl border border-gray-300 bg-white text-gray-700 text-sm font-medium hover:bg-gray-50 transition-colors"
          >
            返回首页
          </a>
        </div>
        <p className="text-xs text-gray-400 mt-6">
          如问题持续，请将错误 ID 发送给管理员
        </p>
      </div>
    </div>
  );
}
