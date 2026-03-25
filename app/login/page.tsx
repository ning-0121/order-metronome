'use client';
import { useState, Suspense } from 'react';
import { signIn, signUp } from '@/app/actions/auth';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

type Mode = 'login' | 'register' | 'forgot';

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const error = searchParams.get('error');

  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'error' | 'success'; text: string } | null>(
    error ? { type: 'error', text: '邮箱域名不在允许范围内，请使用 @qimoclothing.com 邮箱' } : null
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setMessage(null);

    try {
      if (mode === 'register') {
        const result = await signUp(email, password, name);
        if (result.error) {
          setMessage({ type: 'error', text: result.error });
        } else {
          setMessage({ type: 'success', text: '注册成功！请等待管理员授权角色后登录。' });
          setMode('login');
        }
      } else {
        const result = await signIn(email, password);
        if (result.error) {
          setMessage({ type: 'error', text: result.error });
        } else {
          router.push('/');
          router.refresh();
        }
      }
    } catch (err: any) {
      console.error('[登录] 异常:', err);
      const msg = err?.message || '';
      if (msg.includes('Email not confirmed') || msg.includes('not confirmed')) {
        setMessage({ type: 'error', text: '邮箱尚未验证。请检查收件箱（或垃圾邮件），点击验证链接后再登录。' });
      } else if (msg.includes('Invalid login')) {
        setMessage({ type: 'error', text: '邮箱或密码错误，请重试' });
      } else {
        setMessage({ type: 'error', text: '登录失败：' + (msg || '未知错误，请重试') });
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleForgotPassword(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setMessage(null);

    if (!email) {
      setMessage({ type: 'error', text: '请先输入邮箱地址' });
      setLoading(false);
      return;
    }
    if (!email.endsWith('@qimoclothing.com')) {
      setMessage({ type: 'error', text: '仅允许 @qimoclothing.com 邮箱' });
      setLoading(false);
      return;
    }

    try {
      const supabase = createClient();
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth/reset-password`,
      });
      if (error) {
        setMessage({ type: 'error', text: '发送失败：' + error.message });
      } else {
        setMessage({
          type: 'success',
          text: '重置邮件已发送到 ' + email + '，请查收邮件并点击链接重置密码。',
        });
      }
    } catch {
      setMessage({ type: 'error', text: '发送失败，请重试' });
    } finally {
      setLoading(false);
    }
  }

  const titles = {
    login: '登录账户',
    register: '注册账户',
    forgot: '重置密码',
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-md space-y-6 rounded-2xl bg-white p-8 shadow-sm border border-gray-200">
        {/* Logo */}
        <div className="text-center">
          <div className="flex items-center justify-center gap-2 mb-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 text-white text-xl">⏱</div>
            <span className="text-xl font-bold text-gray-900">订单节拍器</span>
          </div>
          <p className="text-xs text-gray-400 mb-1">卡风险，而不是走流程</p>
          <p className="text-sm font-medium text-gray-600">{titles[mode]}</p>
          <p className="text-xs text-gray-400 mt-1">仅限 @qimoclothing.com 邮箱</p>
        </div>

        {/* 消息提示 */}
        {message && (
          <div className={`rounded-xl px-4 py-3 text-sm ${
            message.type === 'error'
              ? 'bg-red-50 text-red-700 border border-red-200'
              : 'bg-green-50 text-green-700 border border-green-200'
          }`}>
            {message.text}
          </div>
        )}

        {/* 表单 */}
        <form onSubmit={mode === 'forgot' ? handleForgotPassword : handleSubmit} className="space-y-4">
          {mode === 'register' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">姓名</label>
              <input
                type="text" required value={name}
                onChange={e => setName(e.target.value)}
                placeholder="你的姓名"
                className="block w-full rounded-xl border border-gray-300 px-3 py-2.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">邮箱地址</label>
            <input
              type="email" required value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="your.name@qimoclothing.com"
              autoComplete="email"
              className="block w-full rounded-xl border border-gray-300 px-3 py-2.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>

          {mode !== 'forgot' && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-sm font-medium text-gray-700">密码</label>
                {mode === 'login' && (
                  <button
                    type="button"
                    onClick={() => { setMode('forgot'); setMessage(null); }}
                    className="text-xs text-indigo-600 hover:text-indigo-700 hover:underline"
                  >
                    忘记密码？
                  </button>
                )}
              </div>
              <input
                type="password" required value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder={mode === 'register' ? '至少 8 位密码' : '请输入密码'}
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                className="block w-full rounded-xl border border-gray-300 px-3 py-2.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>
          )}

          <button
            type="submit" disabled={loading}
            className="w-full rounded-xl bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            {loading ? '处理中...' : mode === 'login' ? '登录' : mode === 'register' ? '注册' : '发送重置邮件'}
          </button>
        </form>

        {/* 切换模式 */}
        <div className="text-center space-y-2">
          {mode !== 'login' && (
            <button onClick={() => { setMode('login'); setMessage(null); }}
              className="text-sm text-indigo-600 hover:underline block w-full">
              已有账户？登录
            </button>
          )}
          {mode !== 'register' && (
            <button onClick={() => { setMode('register'); setMessage(null); }}
              className="text-sm text-gray-500 hover:text-gray-700 hover:underline block w-full">
              还没有账户？注册
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center bg-gray-50 text-gray-400">加载中...</div>}>
      <LoginForm />
    </Suspense>
  );
}
