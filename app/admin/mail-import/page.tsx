'use client';

import { useState } from 'react';
import Link from 'next/link';

const STAFF_EMAILS = [
  'alex@qimoclothing.com',
  'su@qimoclothing.com',
  'lucy@qimoclothing.com',
  'vivi@qimoclothing.com',
  'claire@qimoclothing.com',
  'helen@qimoclothing.com',
];

export default function MailImportPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [days, setDays] = useState(90);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<Array<{ email: string; result: string; time: string }>>([]);

  async function handleImport() {
    if (!email || !password) { setError('请填写邮箱和密码'); return; }
    setLoading(true);
    setError('');
    setResult(null);

    try {
      const res = await fetch('/api/mail-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, days }),
      });
      const data = await res.json();

      if (data.error) {
        setError(data.error);
      } else {
        setResult(data);
        setHistory(prev => [
          { email, result: data.message, time: new Date().toLocaleTimeString() },
          ...prev,
        ]);
      }
    } catch (err: any) {
      setError(err.message || '请求失败');
    }
    setLoading(false);
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">📧 邮件历史导入</h1>
          <p className="text-sm text-gray-500 mt-1">从业务员邮箱导入历史邮件，建立客户画像</p>
        </div>
        <Link href="/admin" className="text-sm text-gray-400 hover:text-gray-600">← 返回管理</Link>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">业务员邮箱</label>
          <div className="flex gap-2">
            <select
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="">选择业务员...</option>
              {STAFF_EMAILS.map(e => (
                <option key={e} value={e}>{e}</option>
              ))}
            </select>
            <input
              type="text"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="或手动输入邮箱"
              className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            IMAP 密码（授权码）
          </label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="在企业微信后台获取"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
          <p className="text-xs text-gray-400 mt-1">
            获取方式：企业微信管理后台 → 邮件 → 邮箱账号 → 该员工 → 密码 → 选择 IMAP → 点击获取
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            回溯天数
          </label>
          <select
            value={days}
            onChange={e => setDays(parseInt(e.target.value))}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="30">最近 30 天</option>
            <option value="60">最近 60 天</option>
            <option value="90">最近 90 天</option>
            <option value="120">最近 120 天</option>
            <option value="180">最近 180 天</option>
          </select>
        </div>

        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {result && (
          <div className="rounded-lg bg-green-50 border border-green-200 p-3 text-sm text-green-700">
            {result.message}
          </div>
        )}

        <button
          onClick={handleImport}
          disabled={loading || !email || !password}
          className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm text-white font-medium hover:bg-indigo-700 disabled:opacity-50"
        >
          {loading ? '导入中...（最多需要60秒）' : '开始导入'}
        </button>
      </div>

      {/* 导入记录 */}
      {history.length > 0 && (
        <div className="mt-6 bg-white rounded-xl border border-gray-200 p-6">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">本次导入记录</h3>
          <div className="space-y-2">
            {history.map((h, i) => (
              <div key={i} className="flex items-center justify-between text-sm bg-gray-50 rounded-lg px-3 py-2">
                <span className="text-gray-600">{h.email}</span>
                <span className="text-gray-800">{h.result}</span>
                <span className="text-gray-400 text-xs">{h.time}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-6 bg-amber-50 rounded-xl border border-amber-200 p-4 text-sm text-amber-800">
        <p className="font-medium mb-2">操作说明</p>
        <ol className="list-decimal list-inside space-y-1 text-xs text-amber-700">
          <li>在企业微信管理后台为每个业务员获取 IMAP 密码</li>
          <li>逐个导入：选业务员 → 填密码 → 点导入</li>
          <li>每次最多导入500封邮件，60秒超时</li>
          <li>已导入的邮件不会重复（自动去重）</li>
          <li>导入后系统会自动分析并建立客户画像</li>
        </ol>
      </div>
    </div>
  );
}
