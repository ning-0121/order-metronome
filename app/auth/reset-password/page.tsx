'use client';
import { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { sendPasswordResetEmail } from '@/app/actions/reset-password';

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'error' | 'success'; text: string } | null>(
    !token ? { type: 'error', text: '重置链接无效或已失效，请返回登录页重新发送重置邮件' } : null
  );

  // Resend mode: when token is invalid/expired, allow user to resend from this page
  const [resendEmail, setResendEmail] = useState('');
  const [showResend, setShowResend] = useState(false);
  const [resending, setResending] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);

    if (!token) {
      setMessage({ type: 'error', text: '重置链接无效，请重新发送重置邮件' });
      setShowResend(true);
      return;
    }
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
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const json = await res.json();

      if (json.success) {
        setMessage({ type: 'success', text: '密码已更新！正在跳转到登录页...' });
        setTimeout(() => router.push('/login'), 1500);
      } else {
        // If token expired/invalid, show resend option
        const isTokenError = json.error?.includes('失效') || json.error?.includes('无效');
        setMessage({ type: 'error', text: json.error || '密码更新失败，请重试' });
        if (isTokenError) {
          setShowResend(true);
        }
      }
    } catch {
      setMessage({ type: 'error', text: '网络错误，请重试' });
    } finally {
      setLoading(false);
    }
  }

  async function handleResend(e: React.FormEvent) {
    e.preventDefault();
    if (!resendEmail || !resendEmail.endsWith('@qimoclothing.com')) {
      setMessage({ type: 'error', text: '请输入 @qimoclothing.com 邮箱' });
      return;
    }
    setResending(true);
    setMessage(null);
    try {
      const result = await sendPasswordResetEmail(resendEmail);
      if (result.error) {
        setMessage({ type: 'error', text: result.error });
      } else {
        setMessage({ type: 'success', text: `重置邮件已发送到 ${resendEmail}，请查收邮件并点击新的链接。` });
        setShowResend(false);
      }
    } catch {
      setMessage({ type: 'error', text: '发送失败，请重试' });
    } finally {
      setResending(false);
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
              <p className="text-sm font-bold text-amber-800 mb-2">请用浏览器打开</p>
              <p className="text-xs text-amber-700 mb-2">微信内可能无法正常重置密码，建议点击右上角 ··· 选择"在浏览器中打开"</p>
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

        {/* Message display */}
        {message && (
          <div className={`rounded-xl px-4 py-3 text-sm mb-4 ${
            message.type === 'error'
              ? 'bg-red-50 text-red-700 border border-red-200'
              : 'bg-green-50 text-green-700 border border-green-200'
          }`}>
            {message.text}
          </div>
        )}

        {/* Normal reset form */}
        {!showResend && (
          <form onSubmit={handleSubmit} className="space-y-4">
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
              type="submit" disabled={loading || !token}
              className="w-full rounded-xl bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {loading ? '更新中...' : '确认修改密码'}
            </button>
          </form>
        )}

        {/* Resend reset email form (shown when token is expired/invalid) */}
        {showResend && (
          <form onSubmit={handleResend} className="space-y-4">
            <div className="rounded-xl bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
              链接已失效，请重新发送重置邮件
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">邮箱地址</label>
              <input
                type="email" required value={resendEmail}
                onChange={e => setResendEmail(e.target.value)}
                placeholder="your.name@qimoclothing.com"
                className="block w-full rounded-xl border border-gray-300 px-3 py-2.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>
            <button
              type="submit" disabled={resending}
              className="w-full rounded-xl bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {resending ? '发送中...' : '重新发送重置邮件'}
            </button>
            <button
              type="button"
              onClick={() => setShowResend(false)}
              className="w-full text-sm text-gray-500 hover:text-gray-700"
            >
              返回输入密码
            </button>
          </form>
        )}

        <div className="text-center mt-4 space-y-2">
          {!showResend && !token && (
            <button
              onClick={() => setShowResend(true)}
              className="text-xs text-indigo-600 hover:text-indigo-700 hover:underline block w-full"
            >
              重新发送重置邮件
            </button>
          )}
          <a href="/login" className="text-xs text-gray-400 hover:text-gray-600 block">← 返回登录</a>
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
