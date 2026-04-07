'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getSilentFailureMails, markMailHandled } from '@/app/actions/mail-monitor';

interface SilentMail {
  id: string;
  from_email: string;
  subject: string;
  received_at: string;
  processing_status: string;
  customer_id: string | null;
  order_id: string | null;
  last_processed_at: string | null;
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  unmatched: { label: '客户+订单都未匹配', color: 'bg-red-100 text-red-700 border-red-200' },
  matched_customer: { label: '只匹配到客户', color: 'bg-amber-100 text-amber-700 border-amber-200' },
  parse_failed: { label: 'AI 解析失败', color: 'bg-purple-100 text-purple-700 border-purple-200' },
};

export default function MailMonitorPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [mails, setMails] = useState<SilentMail[]>([]);
  const [stats, setStats] = useState({ unmatched: 0, matched_customer: 0, parse_failed: 0 });
  const [days, setDays] = useState(7);

  async function load() {
    setLoading(true);
    setError('');
    const res = await getSilentFailureMails(days);
    if (res.error) setError(res.error);
    else if (res.data) {
      setMails(res.data.mails);
      setStats(res.data.stats);
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, [days]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleMark(id: string) {
    if (!confirm('标记该邮件为「已人工处理」？')) return;
    const res = await markMailHandled(id);
    if (res.error) alert(res.error);
    else load();
  }

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <Link href="/admin" className="text-sm text-gray-500 hover:underline">← 返回管理后台</Link>
          <h1 className="text-2xl font-bold text-gray-900 mt-1">📧 邮件无声失败监控</h1>
          <p className="text-sm text-gray-500 mt-1">
            找出"被吞掉"的邮件 — 客户未识别 / 订单未匹配的邮件不会触发任何通知，业务员看不到。
          </p>
        </div>
        <select
          value={days}
          onChange={e => setDays(Number(e.target.value))}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
        >
          <option value={1}>近 1 天</option>
          <option value={3}>近 3 天</option>
          <option value={7}>近 7 天</option>
          <option value={14}>近 14 天</option>
          <option value={30}>近 30 天</option>
        </select>
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="rounded-xl border border-red-200 bg-red-50 p-4">
          <p className="text-xs text-red-700">客户+订单都未匹配</p>
          <p className="text-3xl font-bold text-red-800 mt-1">{stats.unmatched}</p>
          <p className="text-xs text-red-600 mt-1">这些邮件完全没人看见</p>
        </div>
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-xs text-amber-700">只匹配到客户</p>
          <p className="text-3xl font-bold text-amber-800 mt-1">{stats.matched_customer}</p>
          <p className="text-xs text-amber-600 mt-1">紧急/样品仍会通知，普通变更被吞</p>
        </div>
        <div className="rounded-xl border border-purple-200 bg-purple-50 p-4">
          <p className="text-xs text-purple-700">AI 解析失败</p>
          <p className="text-3xl font-bold text-purple-800 mt-1">{stats.parse_failed}</p>
          <p className="text-xs text-purple-600 mt-1">AI 返回格式错误</p>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-gray-400 text-center py-8">加载中...</p>
      ) : mails.length === 0 ? (
        <div className="rounded-xl border border-green-200 bg-green-50 p-8 text-center">
          <p className="text-2xl mb-2">✅</p>
          <p className="text-green-800 font-medium">近 {days} 天没有被吞掉的邮件</p>
        </div>
      ) : (
        <div className="space-y-2">
          {mails.map(m => {
            const cfg = STATUS_LABELS[m.processing_status] || { label: m.processing_status, color: 'bg-gray-100 text-gray-700' };
            return (
              <div key={m.id} className="rounded-lg border border-gray-200 bg-white p-4 hover:border-gray-300">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium border ${cfg.color}`}>
                        {cfg.label}
                      </span>
                      <span className="text-xs text-gray-400">
                        {new Date(m.received_at).toLocaleString('zh-CN')}
                      </span>
                    </div>
                    <p className="text-sm font-medium text-gray-900 truncate">{m.subject}</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      发件人：{m.from_email}
                      {m.customer_id && ` · 客户：${m.customer_id}`}
                    </p>
                  </div>
                  <button
                    onClick={() => handleMark(m.id)}
                    className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 shrink-0"
                  >
                    标记已处理
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-6 text-xs text-gray-400 border-t border-gray-100 pt-4">
        💡 邮件 cron 每 15 分钟扫描一次未处理邮件。如果某封邮件持续未被识别，
        说明该客户的邮箱域名还没建立映射 — 建议在「客户管理」里手动建立域名映射。
      </div>
    </div>
  );
}
