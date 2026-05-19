'use client';

/**
 * 路由级 loading / error 兜底组件
 *
 * 用法：每个路由的 loading.tsx / error.tsx 都直接 re-export 这里的组件，
 * 不要重复 39 份样式代码。当全局视觉变了，改这一个文件即可。
 *
 *   // app/admin/overdue/loading.tsx
 *   export { RouteLoading as default } from '@/components/RouteFallback';
 *
 *   // app/admin/overdue/error.tsx
 *   'use client';
 *   export { RouteError as default } from '@/components/RouteFallback';
 *
 * 设计：
 *   - loading：骨架屏 + 微动画（不假装内容，明确告诉用户在加载）
 *   - error：友好提示 + reset() 按钮 + 错误 hash 便于运维排查
 */

import { useEffect } from 'react';

export function RouteLoading() {
  return (
    <div className="min-h-[40vh] flex items-center justify-center px-4">
      <div className="flex flex-col items-center gap-3 text-gray-500">
        <div className="w-10 h-10 rounded-full border-4 border-indigo-200 border-t-indigo-600 animate-spin" />
        <p className="text-sm">加载中…</p>
      </div>
    </div>
  );
}

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export function RouteError({ error, reset }: ErrorProps) {
  // 把错误打到 console，运维通过浏览器 DevTools / Sentry 能看到完整堆栈
  useEffect(() => {
    console.error('[RouteError]', error);
  }, [error]);

  return (
    <div className="min-h-[40vh] flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-white border border-red-200 rounded-2xl p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <span className="text-3xl">⚠️</span>
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold text-gray-900">页面加载出了点问题</h2>
            <p className="text-sm text-gray-600 mt-1">
              请尝试刷新；如果反复出现，把这条信息截图发给技术：
            </p>
            <pre className="mt-3 p-2 rounded bg-gray-50 border border-gray-200 text-[11px] text-gray-700 whitespace-pre-wrap break-words">
              {error?.message || '未知错误'}
              {error?.digest && `\n  digest: ${error.digest}`}
            </pre>
            <div className="mt-4 flex flex-col sm:flex-row gap-2">
              <button
                onClick={reset}
                className="px-4 py-2.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 active:bg-indigo-800"
              >
                ↻ 重试
              </button>
              <a
                href="/"
                className="px-4 py-2.5 rounded-lg border border-gray-300 bg-white text-sm text-gray-700 text-center hover:bg-gray-50"
              >
                返回首页
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
