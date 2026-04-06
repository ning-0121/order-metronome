'use client';

import { useState, useEffect, useMemo } from 'react';
import {
  getOrderEmails,
  getCustomerEmails,
  linkEmailToOrder,
  bindEmailToCustomer,
} from '@/app/actions/customer-email-mapping';
import { formatDate } from '@/lib/utils/date';

interface Props {
  orderId: string;
  customerName: string;
  orderNo: string;
}

interface EmailRecord {
  id: string;
  from_email: string;
  subject: string;
  raw_body?: string;
  received_at: string;
  customer_id: string | null;
  extracted_po: string | null;
  order_id?: string | null;
  thread_id: string | null;
}

/**
 * 从邮件主题提取线索ID（去除 Re:/Fwd: 前缀）
 */
function extractThreadSubject(subject: string): string {
  return subject
    .replace(/^(re|fwd|fw|回复|转发)\s*[:：]\s*/gi, '')
    .replace(/^(re|fwd|fw)\s*\[\d+\]\s*[:：]?\s*/gi, '')
    .trim()
    .toLowerCase();
}

/**
 * 判断两封邮件是否属于同一个对话线索
 */
function isSameThread(a: EmailRecord, b: EmailRecord): boolean {
  // 如果都有 thread_id 且相同
  if (a.thread_id && b.thread_id && a.thread_id === b.thread_id) return true;
  // 主题线匹配
  return extractThreadSubject(a.subject) === extractThreadSubject(b.subject);
}

export function EmailTab({ orderId, customerName, orderNo }: Props) {
  const [orderEmails, setOrderEmails] = useState<EmailRecord[]>([]);
  const [customerEmails, setCustomerEmails] = useState<EmailRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [view, setView] = useState<'order' | 'customer' | 'thread'>('order');
  const [linking, setLinking] = useState<string | null>(null);

  useEffect(() => {
    loadEmails();
  }, [orderId, customerName]);

  async function loadEmails() {
    setLoading(true);
    const [orderResult, customerResult] = await Promise.all([
      getOrderEmails(orderId),
      customerName ? getCustomerEmails(customerName, 100) : Promise.resolve({ data: null }),
    ]);
    setOrderEmails(orderResult.data || []);
    setCustomerEmails(customerResult.data || []);
    setLoading(false);
  }

  // 按线索分组
  const threads = useMemo(() => {
    const all = view === 'order' ? orderEmails : customerEmails;
    const groups: Map<string, EmailRecord[]> = new Map();

    for (const email of all) {
      const threadKey = extractThreadSubject(email.subject);
      const existing = groups.get(threadKey) || [];
      existing.push(email);
      groups.set(threadKey, existing);
    }

    // 排序：每个线索按最新邮件时间排列
    return Array.from(groups.entries())
      .map(([key, emails]) => ({
        key,
        emails: emails.sort((a, b) => new Date(a.received_at).getTime() - new Date(b.received_at).getTime()),
        latestDate: emails.reduce((max, e) => {
          const t = new Date(e.received_at).getTime();
          return t > max ? t : max;
        }, 0),
        firstDate: emails.reduce((min, e) => {
          const t = new Date(e.received_at).getTime();
          return t < min ? t : min;
        }, Infinity),
      }))
      .sort((a, b) => b.latestDate - a.latestDate);
  }, [orderEmails, customerEmails, view]);

  // 找到最早的邮件（订单沟通起源）
  const earliestEmail = useMemo(() => {
    if (orderEmails.length === 0) return null;
    return orderEmails.reduce((earliest, e) =>
      new Date(e.received_at).getTime() < new Date(earliest.received_at).getTime() ? e : earliest
    , orderEmails[0]);
  }, [orderEmails]);

  // 将客户邮件关联到当前订单
  async function handleLinkToOrder(emailId: string) {
    setLinking(emailId);
    const { error } = await linkEmailToOrder(emailId, orderId, customerName);
    if (!error) await loadEmails();
    setLinking(null);
  }

  // 一键绑定邮箱到客户
  async function handleBindEmail(fromEmail: string) {
    const { error } = await bindEmailToCustomer(fromEmail, customerName);
    if (!error) await loadEmails();
  }

  if (loading) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
        <div className="text-gray-400 text-sm">加载邮件记录...</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 顶部统计 + 视图切换 */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <h3 className="text-sm font-semibold text-gray-900">邮件往来</h3>
            <span className="text-xs text-gray-500">
              本订单 {orderEmails.length} 封
              {customerName && ` · ${customerName} 全部 ${customerEmails.length} 封`}
            </span>
          </div>
          <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
            {[
              { key: 'order' as const, label: '本订单' },
              { key: 'customer' as const, label: '全部往来' },
              { key: 'thread' as const, label: '按线索' },
            ].map(v => (
              <button
                key={v.key}
                onClick={() => setView(v.key)}
                className={`text-xs px-3 py-1 rounded-md transition-colors ${
                  view === v.key
                    ? 'bg-white text-indigo-700 shadow-sm font-medium'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {v.label}
              </button>
            ))}
          </div>
        </div>

        {/* 订单沟通起源标记 */}
        {earliestEmail && view === 'order' && (
          <div className="mt-3 p-3 bg-amber-50 rounded-lg border border-amber-200">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-amber-600 font-medium">🔍 订单沟通起源</span>
              <span className="text-gray-600">
                {formatDate(earliestEmail.received_at)} · {earliestEmail.from_email}
              </span>
            </div>
            <p className="text-xs text-gray-600 mt-1 truncate">{earliestEmail.subject}</p>
          </div>
        )}
      </div>

      {/* 邮件列表 */}
      {view === 'thread' ? (
        // 按线索分组展示
        threads.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-8 text-center text-gray-400 text-sm">
            暂无邮件记录
          </div>
        ) : (
          threads.map(thread => (
            <div key={thread.key} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-4 py-3 bg-gray-50 border-b border-gray-100">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-sm font-medium text-gray-800 capitalize">{thread.key || '(无主题)'}</span>
                    <span className="ml-2 text-xs text-gray-400">{thread.emails.length} 封</span>
                  </div>
                  <span className="text-xs text-gray-400">
                    {formatDate(new Date(thread.firstDate).toISOString())} → {formatDate(new Date(thread.latestDate).toISOString())}
                  </span>
                </div>
              </div>
              <div className="divide-y divide-gray-50">
                {thread.emails.map((email, idx) => (
                  <EmailRow
                    key={email.id}
                    email={email}
                    isFirst={idx === 0}
                    isExpanded={expandedId === email.id}
                    onToggle={() => setExpandedId(expandedId === email.id ? null : email.id)}
                    showLinkButton={view !== 'order' && email.order_id !== orderId}
                    onLink={() => handleLinkToOrder(email.id)}
                    linking={linking === email.id}
                    customerName={customerName}
                    onBindEmail={email.customer_id ? undefined : () => handleBindEmail(email.from_email)}
                  />
                ))}
              </div>
            </div>
          ))
        )
      ) : (
        // 扁平列表
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          {(view === 'order' ? orderEmails : customerEmails).length === 0 ? (
            <div className="p-8 text-center text-gray-400 text-sm">
              {view === 'order' ? '暂无关联邮件' : '暂无客户邮件'}
            </div>
          ) : (
            <div className="divide-y divide-gray-50">
              {(view === 'order' ? orderEmails : customerEmails).map((email, idx) => (
                <EmailRow
                  key={email.id}
                  email={email}
                  isFirst={orderEmails.length > 0 && email.id === earliestEmail?.id}
                  isExpanded={expandedId === email.id}
                  onToggle={() => setExpandedId(expandedId === email.id ? null : email.id)}
                  showLinkButton={view === 'customer' && email.order_id !== orderId}
                  onLink={() => handleLinkToOrder(email.id)}
                  linking={linking === email.id}
                  customerName={customerName}
                  onBindEmail={email.customer_id ? undefined : () => handleBindEmail(email.from_email)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 单封邮件展示行
 */
function EmailRow({
  email,
  isFirst,
  isExpanded,
  onToggle,
  showLinkButton,
  onLink,
  linking,
  customerName,
  onBindEmail,
}: {
  email: EmailRecord;
  isFirst: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  showLinkButton: boolean;
  onLink: () => void;
  linking: boolean;
  customerName: string;
  onBindEmail?: () => void;
}) {
  const isInternal = email.from_email?.includes('@qimoclothing.com');
  const domain = email.from_email?.split('@')[1] || '';

  return (
    <div className={`${isFirst ? 'bg-amber-50/30' : ''}`}>
      <div
        className="px-4 py-3 flex items-start gap-3 cursor-pointer hover:bg-gray-50 transition-colors"
        onClick={onToggle}
      >
        {/* 方向指示 + 时间线 */}
        <div className="flex flex-col items-center pt-1">
          <span className={`text-lg ${isInternal ? '↗' : '↙'}`} title={isInternal ? '我方发出' : '客户来件'}>
            {isInternal ? '📤' : '📩'}
          </span>
          {isFirst && (
            <span className="text-[10px] mt-0.5 text-amber-600 font-bold">起源</span>
          )}
        </div>

        {/* 邮件内容 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-900 truncate">{email.subject || '(无主题)'}</span>
            {email.extracted_po && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 shrink-0">
                PO: {email.extracted_po}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className={`text-xs ${isInternal ? 'text-green-600' : 'text-gray-500'}`}>
              {email.from_email}
            </span>
            <span className="text-xs text-gray-400">{formatDate(email.received_at)}</span>
            {email.customer_id && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
                {email.customer_id}
              </span>
            )}
          </div>
        </div>

        {/* 操作按钮 */}
        <div className="flex items-center gap-2 shrink-0">
          {onBindEmail && (
            <button
              onClick={e => { e.stopPropagation(); onBindEmail(); }}
              className="text-[10px] px-2 py-1 rounded border border-amber-300 text-amber-700 hover:bg-amber-50"
              title={`将 @${domain} 绑定到 ${customerName}`}
            >
              绑定客户
            </button>
          )}
          {showLinkButton && (
            <button
              onClick={e => { e.stopPropagation(); onLink(); }}
              disabled={linking}
              className="text-[10px] px-2 py-1 rounded border border-indigo-300 text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
            >
              {linking ? '...' : '关联本单'}
            </button>
          )}
          <span className="text-gray-400 text-sm">{isExpanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {/* 展开正文 */}
      {isExpanded && email.raw_body && (
        <div className="px-4 pb-4 pl-12">
          <div className="bg-gray-50 rounded-lg p-3 text-xs text-gray-600 whitespace-pre-wrap max-h-60 overflow-y-auto leading-relaxed">
            {email.raw_body.slice(0, 2000)}
            {email.raw_body.length > 2000 && (
              <span className="text-gray-400 block mt-2">...（内容过长已截断）</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
