'use client';
import { useState, useEffect, Suspense } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';

function ResetPasswordForm() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'error' | 'success'; text: string } | null>(null);
  const [tokenData, setTokenData] = useState<{
    access_token: string | null;
    refresh_token: string | null;
    user_id: string | null;
  }>({ access_token: null, refresh_token: null, user_id: null });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const supabase = createClient();

    // Extract tokens from URL hash (set by callback route)
    const hash = window.location.hash;
    if (hash) {
      const params = new URLSearchParams(hash.substring(1));

      // Check for error from callback
      const hashError = params.get('error');
      if (hashError) {
        setMessage({ type: 'error', text: '重置链接已失效，请重新发送重置邮件' });
        setReady(true);
        return;
      }

      const accessToken = params.get('access_token');
      const refreshToken = params.get('refresh_token') || '';
      const userId = params.get('user_id') || '';

      if (accessToken) {
        setTokenData({ access_token: accessToken, refresh_token: refreshToken, user_id: userId });

        // Try to set session on client
        supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        }).then(({ data }) => {
          if (data.session) setReady(true);
          else setReady(true); // Still allow form — server API will use admin method
        }).catch(() => {
          setReady(true); // Still allow form
        });

        // Clean up hash from URL
        window.history.replaceState(null, '', window.location.pathname);
        return;
      }
    }

    // Fallback: listen for auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        setReady(true);
      }
    });

    // Fallback: check existing session
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) setReady(true);
    });

    // Timeout fallback: show form after 2s regardless
    const timer = setTimeout(() => setReady(true), 2000);

    return () => { subscription.unsubscribe(); clearTimeout(timer); };
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
      // Try 1: Client-side updateUser (works if session was established)
      const supabase = createClient();
      const clientResult = await supabase.auth.updateUser({ password });

      if (!clientResult.error) {
        setMessage({ type: 'success', text: '密码已更新！正在跳转到登录页...' });
        await supabase.auth.signOut();
        setTimeout(() => router.push('/login'), 1500);
        return;
      }

      // Try 2: Server API (uses admin API with service_role as ultimate fallback)
      const res = await fetch('/api/auth/update-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password,
          access_token: tokenData.access_token,
          user_id: tokenData.user_id,
        }),
      });
      const json = await res.json();

      if (json.success) {
        setMessage({ type: 'success', text: '密码已更新！正在跳转到登录页...' });
        try { await supabase.auth.signOut(); } catch {}
        setTimeout(() => router.push('/login'), 1500);
      } else {
        setMessage({ type: 'error', text: '密码更新失败：' + (json.error || '请重新发送重置邮件') });
      }
    } catch (err: any) {
      setMessage({ type: 'error', text: '操作失败：' + (err.message || '请重试') });
    } finally {
      setLoading(false);
    }
  }

  // Detect WeChat browser
  const isWechat = typeof navigator !== 'undefined' && /MicroMessenger/i.test(navigator.userAgent);

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-sm border border-gray-200">
        <div className="text-center mb-6">
          <div className="flex items-center justify-center gap-2 mb-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 text-white text-xl">⏱</div>
            <span className="text-xl font-bold text-gray-900">订单节拍器</span>
          </div>
          <p className="text-sm font-medium text-gray-700">设置新密码</p>

          {isWechat && (
            <div className="mt-3 rounded-xl bg-amber-50 border border-amber-200 p-4 text-left">
              <p className="text-sm font-bold text-amber-800 mb-2">⚠️ 请用浏览器打开</p>
              <p className="text-xs text-amber-700 mb-2">微信内无法重置密码，请点击右上角 ··· 选择"在浏览器中打开"</p>
              <button onClick={() => {
                if (navigator.clipboard) {
                  navigator.clipboard.writeText(window.location.href);
                  alert('链接已复制！请打开手机浏览器粘贴访问');
                }
              }} className="text-xs px-3 py-1.5 rounded-lg bg-amber-600 text-white">
                复制链接
              </button>
            </div>
          )}
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
