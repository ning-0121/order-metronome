'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  getTodayMorningBriefing,
  getSilentFailureMails,
  markMailHandled,
} from '@/app/actions/mail-monitor';

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

interface MorningBriefing {
  briefingDate?: string;
  headline?: string;
  topActions?: Array<{
    rank: number;
    action: string;
    reason?: string;
    customer?: string;
    orderNo?: string;
  }>;
  totalEmailsYesterday?: number;
  urgentEmailsCount?: number;
  openDiffsCount?: number;
  slowConfirmCount?: number;
  silentFailCount?: number;
  urgentItems?: Array<{ id: string; customer: string | null; subject: string; receivedAt: string }>;
  openDiffs?: Array<any>;
  slowConfirms?: Array<any>;
  emailsByCustomer?: Array<{ customer: string; count: number; latestSubject: string }>;
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  unmatched: { label: '客户+订单都未匹配', color: 'bg-red-100 text-red-700 border-red-200' },
  matched_customer: { label: '只匹配到客户', color: 'bg-amber-100 text-amber-700 border-amber-200' },
  parse_failed: { label: 'AI 解析失败', color: 'bg-purple-100 text-purple-700 border-purple-200' },
};

export default function MorningBriefingPage() {
  const [briefing, setBriefing] = useState<MorningBriefing | null>(null);
  const [briefingError, setBriefingError] = useState('');
  const [briefingLoading, setBriefingLoading] = useState(true);

  // 无声失败（保留为底部小卡片）
  const [silentMails, setSilentMails] = useState<SilentMail[]>([]);
  const [silentStats, setSilentStats] = useState({ unmatched: 0, matched_customer: 0, parse_failed: 0 });
  const [silentDays] = useState(7);
  const [showSilent, setShowSilent] = useState(false);

  async function loadBriefing() {
    setBriefingLoading(true);
    setBriefingError('');
    const res = await getTodayMorningBriefing();
    if (res.error) {
      setBriefingError(res.error);
      setBriefing(null);
    } else {
      setBriefing(res.data || null);
    }
    setBriefingLoading(false);
  }

  async function loadSilent() {
    const res = await getSilentFailureMails(silentDays);
    if (res.data) {
      setSilentMails(res.data.mails);
      setSilentStats(res.data.stats);
    }
  }

  useEffect(() => {
    loadBriefing();
    loadSilent();
  }, []);

  async function handleMarkSilent(id: string) {
    if (!confirm('标记该邮件为「已人工处理」？')) return;
    const res = await markMailHandled(id);
    if (res.error) alert(res.error);
    else loadSilent();
  }

  return (
    <div className="max-w-5xl mx-auto p-6">
      <div className="mb-6">
        <Link href="/ceo" className="text-sm text-gray-500 hover:underline">← 返回管理后台</Link>
        <h1 className="text-2xl font-bold text-gray-900 mt-1">📧 今日邮件晨报</h1>
        <p className="text-sm text-gray-500 mt-1">
          每日凌晨 00:00 北京时间自动生成 — AI 帮你梳理昨夜邮件、紧急事项、客户慢确认、订单差异
        </p>
      </div>

      {/* ── 晨报主体 ── */}
      {briefingLoading && (
        <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-gray-400">
          晨报加载中...
        </div>
      )}

      {!briefingLoading && briefingError && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-6">
          <p className="text-amber-800 font-medium">⏳ {briefingError}</p>
          <p className="text-xs text-amber-600 mt-2">
            晨报由 cron 每天凌晨 00:00 自动生成。第一次部署时可能需要等到明天。
          </p>
        </div>
      )}

      {!briefingLoading && !briefingError && briefing && (
        <div className="space-y-4">
          {/* 头条 */}
          <div className="rounded-xl border-2 border-indigo-200 bg-gradient-to-br from-indigo-50 to-white p-6">
            <p className="text-xs text-indigo-500 mb-1">{briefing.briefingDate} · 今日头条</p>
            <h2 className="text-xl font-bold text-gray-900">{briefing.headline}</h2>
          </div>

          {/* 4 个统计卡片 */}
          <div className="grid grid-cols-4 gap-3">
            <StatCard label="昨日新邮件" value={briefing.totalEmailsYesterday || 0} color="bg-blue-50 text-blue-700 border-blue-200" />
            <StatCard label="紧急/投诉" value={briefing.urgentEmailsCount || 0} color="bg-red-50 text-red-700 border-red-200" />
            <StatCard label="待处理差异" value={briefing.openDiffsCount || 0} color="bg-amber-50 text-amber-700 border-amber-200" />
            <StatCard label="客户慢确认" value={briefing.slowConfirmCount || 0} color="bg-orange-50 text-orange-700 border-orange-200" />
          </div>

          {/* 今日 Top Actions */}
          {briefing.topActions && briefing.topActions.length > 0 && (
            <Section title="🎯 今天上午必须做的事" defaultOpen>
              <div className="space-y-2">
                {briefing.topActions.map(a => (
                  <div key={a.rank} className="flex gap-3 p-3 rounded-lg bg-indigo-50 border border-indigo-100">
                    <span className="text-lg font-bold text-indigo-600 shrink-0">#{a.rank}</span>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-gray-900">{a.action}</p>
                      {a.reason && <p className="text-xs text-gray-500 mt-0.5">{a.reason}</p>}
                      {(a.customer || a.orderNo) && (
                        <p className="text-xs text-indigo-600 mt-0.5">
                          {a.customer && <span>{a.customer}</span>}
                          {a.orderNo && <span> · {a.orderNo}</span>}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* 紧急邮件 */}
          {briefing.urgentItems && briefing.urgentItems.length > 0 && (
            <Section title={`🔥 紧急邮件（${briefing.urgentItems.length}）`} defaultOpen>
              <div className="space-y-2">
                {briefing.urgentItems.map(it => (
                  <div key={it.id} className="p-3 rounded-lg bg-red-50 border border-red-200">
                    <p className="text-sm font-medium text-red-800">{it.subject}</p>
                    <p className="text-xs text-red-600 mt-1">
                      {it.customer || '未知客户'} · {new Date(it.receivedAt).toLocaleString('zh-CN')}
                    </p>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* 邮件 vs 订单差异 */}
          {briefing.openDiffs && briefing.openDiffs.length > 0 && (
            <Section title={`⚠️ 邮件 vs 订单差异（${briefing.openDiffs.length}）`} defaultOpen>
              <div className="space-y-2">
                {briefing.openDiffs.map(d => (
                  <div key={d.id} className={`p-3 rounded-lg border ${
                    d.severity === 'high' ? 'bg-red-50 border-red-200' :
                    d.severity === 'medium' ? 'bg-amber-50 border-amber-200' :
                    'bg-gray-50 border-gray-200'
                  }`}>
                    <div className="flex items-center gap-2 text-xs mb-1">
                      <span className="font-medium text-gray-700">{d.field}</span>
                      <span className="text-gray-500">{d.customer} · {d.orderNo}</span>
                    </div>
                    <div className="text-xs text-gray-700">
                      <span className="text-red-600">邮件：{d.emailValue || '—'}</span>
                      <span className="mx-2">vs</span>
                      <span className="text-blue-600">订单：{d.orderValue || '—'}</span>
                    </div>
                    {d.suggestion && <p className="text-xs text-gray-500 mt-1">💡 {d.suggestion}</p>}
                    <Link href={`/orders/${d.orderId}?tab=email_diffs`} className="text-xs text-indigo-600 hover:underline mt-1 inline-block">
                      打开订单 →
                    </Link>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* 客户慢确认 */}
          {briefing.slowConfirms && briefing.slowConfirms.length > 0 && (
            <Section title={`🐢 客户慢确认（已等 5 天+）`}>
              <div className="space-y-2">
                {briefing.slowConfirms.map((s, i) => (
                  <div key={i} className="p-3 rounded-lg bg-orange-50 border border-orange-200">
                    <p className="text-sm font-medium text-orange-900">{s.milestone}</p>
                    <p className="text-xs text-orange-700 mt-1">
                      {s.customer} · {s.orderNo} · 已超期 {s.daysOverdue} 天
                    </p>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* 昨日邮件按客户 */}
          {briefing.emailsByCustomer && briefing.emailsByCustomer.length > 0 && (
            <Section title={`📧 昨日新邮件按客户（${briefing.emailsByCustomer.length} 家）`}>
              <div className="grid grid-cols-2 gap-2">
                {briefing.emailsByCustomer.map((c, i) => (
                  <div key={i} className="p-2 rounded border border-gray-200 bg-white text-xs">
                    <p className="font-medium text-gray-900">{c.customer} <span className="text-gray-500">({c.count} 封)</span></p>
                    <p className="text-gray-500 truncate mt-0.5">{c.latestSubject}</p>
                  </div>
                ))}
              </div>
            </Section>
          )}
        </div>
      )}

      {/* ── 底部：被吞掉的邮件（折叠） ── */}
      <div className="mt-8 pt-6 border-t border-gray-200">
        <button
          onClick={() => setShowSilent(!showSilent)}
          className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-2"
        >
          💀 被吞掉的邮件监控（近 7 天 {silentStats.unmatched + silentStats.matched_customer + silentStats.parse_failed} 封）
          <span>{showSilent ? '▼' : '▶'}</span>
        </button>

        {showSilent && (
          <div className="mt-4 space-y-2">
            <p className="text-xs text-gray-400">
              邮件 cron 每 15 分钟扫描一次。客户/订单未匹配的邮件会进入这里 — 业务员看不到，需要管理员手动处理。
            </p>
            {silentMails.length === 0 ? (
              <p className="text-sm text-gray-400 py-4 text-center">✓ 近 7 天没有被吞掉的邮件</p>
            ) : (
              silentMails.slice(0, 20).map(m => {
                const cfg = STATUS_LABELS[m.processing_status] || { label: m.processing_status, color: 'bg-gray-100' };
                return (
                  <div key={m.id} className="rounded-lg border border-gray-200 bg-white p-3 text-xs">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium border ${cfg.color}`}>
                          {cfg.label}
                        </span>
                        <p className="font-medium text-gray-900 mt-1 truncate">{m.subject}</p>
                        <p className="text-gray-500 mt-0.5">
                          {m.from_email} · {new Date(m.received_at).toLocaleString('zh-CN')}
                        </p>
                      </div>
                      <button
                        onClick={() => handleMarkSilent(m.id)}
                        className="text-[10px] px-2 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 shrink-0"
                      >
                        标记已处理
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className={`rounded-xl border p-4 ${color}`}>
      <p className="text-xs">{label}</p>
      <p className="text-3xl font-bold mt-1">{value}</p>
    </div>
  );
}

function Section({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-5 py-3 flex items-center justify-between hover:bg-gray-50"
      >
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        <span className="text-gray-400 text-xs">{open ? '▲' : '▼'}</span>
      </button>
      {open && <div className="px-5 pb-4">{children}</div>}
    </div>
  );
}
