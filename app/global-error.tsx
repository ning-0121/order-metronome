'use client';

/**
 * 全局错误边界 — layout.tsx 级别崩溃时触发
 * 这是最后一道防线，必须极简，不依赖任何项目组件
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="zh-CN">
      <body style={{ fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif', margin: 0, padding: 0, background: '#fafbfc' }}>
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ maxWidth: 420, textAlign: 'center', padding: 32 }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>⚠</div>
            <h1 style={{ fontSize: 20, fontWeight: 700, color: '#1a1a2e', marginBottom: 8 }}>
              系统遇到了问题
            </h1>
            <p style={{ fontSize: 14, color: '#6b7280', marginBottom: 24, lineHeight: 1.6 }}>
              页面加载失败，请尝试刷新。如问题持续，请联系管理员。
            </p>
            {error?.digest && (
              <p style={{ fontSize: 11, color: '#9ca3af', marginBottom: 16 }}>
                错误 ID: {error.digest}
              </p>
            )}
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
              <button
                onClick={reset}
                style={{
                  padding: '10px 24px', borderRadius: 8, border: 'none',
                  background: '#4f46e5', color: '#fff', fontSize: 14, fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                重试
              </button>
              <a
                href="/login"
                style={{
                  padding: '10px 24px', borderRadius: 8, border: '1px solid #d1d5db',
                  background: '#fff', color: '#374151', fontSize: 14, fontWeight: 500,
                  textDecoration: 'none', display: 'inline-block',
                }}
              >
                返回首页
              </a>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
