'use client';
import { useState, useEffect, Suspense } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useRouter, useSearchParams } from 'next/navigation';

function ResetPasswordForm() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'error' | 'success'; text: string } | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Supabase 会在 URL hash 里带 access_token
    const supabase = createClient();
    supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') {
        setReady(true);
      }
    });
    // 兼容：如果已经有 session 也放行
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) setReady(true);
    });
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);

    if (password.length < 8) {
      setMessage({ type: 'error', text: '密码至少需要 8 位' });
      return;
    }
    if (password !== confirm) {
      setMessage({ type: 'error', text: '两次密码不一致' });
      return;
    }

    setLoading(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.updateUser({ password });
      if (error) {
        setMessage({ type: 'error', text: '密码更新失败：' + error.message });
      } else {
        setMessage({ type: 'success', text: '密码已更新！正在跳转...' });
        setTimeout(() => router.push('/'), 1500);
      }
    } catch {
      setMessage({ type: 'error', text: '操作失败，请重试' });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-sm border border-gray-200">
        <div className="text-center mb-6">
          <div className="flex items-center justify-center gap-2 mb-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 text-white text-xl">⏱</div>
            <span className="text-xl font-bold text-gray-900">订单节拍器</span>
          </div>
          <p className="text-sm font-medium text-gray-700">设置新密码</p>
        </div>

        {!ready ? (
          <div className="text-center py-8 text-gray-400">
            <p className="text-sm">正在验证重置链接...</p>
            <p className="text-xs mt-2 text-gray-300">如果长时间未响应，请返回登录页重新发送重置邮件</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {message && (
              <div className={`rounded-xl px-4 py-3 text-sm ${
                message.type === 'error'
                  ? 'bg-red-50 text-red-700 border border-red-200'
                  : 'bg-green-50 text-green-700 border border-green-200'
              }`}>
                {message.text}
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">新密码</label>
              <input
                type="password" required value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="至少 8 位"
                className="block w-full rounded-xl border border-gray-300 px-3 py-2.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">确认新密码</label>
              <input
                type="password" required value={confirm}
                onChange={e => setConfirm(e.target.value)}
                placeholder="再次输入新密码"
                className="block w-full rounded-xl border border-gray-300 px-3 py-2.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>
            <button
              type="submit" disabled={loading}
              className="w-full rounded-xl bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {loading ? '更新中...' : '确认修改密码'}
            </button>
          </form>
        )}

        <div className="text-center mt-4">
          <a href="/login" className="text-xs text-gray-400 hover:text-gray-600">← 返回登录</a>
        </div>
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center bg-gray-50 text-gray-400">加载中...</div>}>
      <ResetPasswordForm />
    </Suspense>
  );
}
