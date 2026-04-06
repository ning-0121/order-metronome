'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { BriefingContent } from '@/lib/agent/dailyBriefing';

interface Props {
  content: BriefingContent;
  briefingDate: string;
}

const severityColors: Record<string, string> = {
  high: 'bg-red-100 text-red-700',
  medium: 'bg-yellow-100 text-yellow-700',
  low: 'bg-gray-100 text-gray-600',
};

const typeLabels: Record<string, string> = {
  po_confirmed_no_order: 'PO确认未建单',
  quantity_mismatch_stale: '数量差异未修正',
  delivery_date_not_updated: '交期变更未更新',
  complaint_not_addressed: '客户投诉未处理',
  sample_feedback_not_updated: '样品反馈未更新',
  urgent_unanswered: '紧急邮件未回复',
  requirements_not_documented: '重要要求未记录',
  modification_not_applied: '客户修改未执行',
};

export function BriefingCard({ content, briefingDate }: Props) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const toggle = (key: string) => setExpanded(prev => ({ ...prev, [key]: !prev[key] }));

  return (
    <div className="space-y-4">
      {/* 💡 AI 优先级建议 */}
      {content.prioritySuggestions.length > 0 && (
        <Section title="💡 AI 建议 — 今天先做这些" defaultOpen>
          <div className="space-y-2">
            {content.prioritySuggestions.map((s, i) => (
              <div key={i} className="flex gap-3 p-3 rounded-lg bg-indigo-50 border border-indigo-100">
                <span className="text-lg font-bold text-indigo-600 shrink-0">#{s.rank}</span>
                <div>
                  <p className="text-sm font-medium text-gray-900">{s.action}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{s.reason}</p>
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* 🚨 紧急待处理 */}
      {content.urgentItems.length > 0 && (
        <Section title={`🚨 紧急待处理（${content.urgentItems.length}）`} defaultOpen>
          <div className="space-y-2">
            {content.urgentItems.map((item, i) => (
              <div key={i} className="p-3 rounded-lg bg-red-50 border border-red-200">
                <p className="text-sm font-medium text-red-800">{item.description}</p>
                <p className="text-xs text-red-600 mt-1">{item.customer}</p>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* 📧 昨日新邮件 */}
      {content.newEmails.length > 0 && (
        <Section title={`📧 新邮件（${content.newEmails.reduce((s, g) => s + g.emails.length, 0)}封）`} defaultOpen>
          <div className="space-y-3">
            {content.newEmails.map((group, i) => (
              <div key={i} className="border border-gray-200 rounded-lg overflow-hidden">
                <button
                  onClick={() => toggle(`email-${i}`)}
                  className="w-full px-4 py-2.5 flex items-center justify-between bg-gray-50 hover:bg-gray-100"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-900">{group.customer}</span>
                    <span className="text-xs text-gray-400">{group.emails.length}封</span>
                  </div>
                  <span className="text-gray-400 text-sm">{expanded[`email-${i}`] ? '▲' : '▼'}</span>
                </button>
                {group.emails[0]?.summary && (
                  <div className="px-4 py-2 text-xs text-indigo-700 bg-indigo-50 border-t border-indigo-100">
                    {group.emails[0].summary}
                  </div>
                )}
                {expanded[`email-${i}`] && (
                  <div className="divide-y divide-gray-50">
                    {group.emails.map((email, j) => (
                      <div key={j} className="px-4 py-2 text-sm">
                        <p className="text-gray-800">{email.subject}</p>
                        <p className="text-xs text-gray-400 mt-0.5">{email.from} · {email.date}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* 📋 今日跟进 */}
      {content.followUpsDue.length > 0 && (
        <Section title={`📋 今日到期节点（${content.followUpsDue.length}）`}>
          <div className="space-y-2">
            {content.followUpsDue.map((item, i) => (
              <div key={i} className="flex items-center justify-between p-3 rounded-lg bg-amber-50 border border-amber-200">
                <div>
                  <p className="text-sm font-medium text-gray-900">{item.milestone}</p>
                  <p className="text-xs text-gray-500">{item.customer} · {item.orderNo}</p>
                </div>
                <span className="text-xs text-amber-700 font-medium">{item.dueDate}</span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* 🔍 执行偏差 */}
      {content.complianceIssues.length > 0 && (
        <Section title={`🔍 执行偏差（${content.complianceIssues.length}）`}>
          <div className="space-y-2">
            {content.complianceIssues.map((issue, i) => (
              <div key={i} className="p-3 rounded-lg border border-gray-200">
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${severityColors[issue.severity]}`}>
                    {issue.severity === 'high' ? '严重' : issue.severity === 'medium' ? '注意' : '轻微'}
                  </span>
                  <span className="text-xs text-gray-500">{typeLabels[issue.type] || issue.type}</span>
                </div>
                <p className="text-sm text-gray-800 mt-1">{issue.description}</p>
                {issue.orderId && (
                  <Link href={`/orders/${issue.orderId}`} className="text-xs text-indigo-600 hover:underline mt-1 inline-block">
                    查看订单 →
                  </Link>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* ✉️ 待审回复草稿 */}
      {content.draftReplies.length > 0 && (
        <Section title={`✉️ AI 回复草稿（${content.draftReplies.length}）`}>
          <div className="space-y-2">
            {content.draftReplies.map((draft, i) => (
              <div key={i} className="p-3 rounded-lg bg-blue-50 border border-blue-200">
                <p className="text-sm font-medium text-blue-800">{draft.emailSubject}</p>
                <p className="text-xs text-blue-600 mt-1">{draft.draftPreview}</p>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* 空状态 */}
      {content.newEmails.length === 0 && content.urgentItems.length === 0 && content.followUpsDue.length === 0 && (
        <div className="text-center py-12 text-gray-400">
          <p className="text-lg">✨ 今天暂时没有待处理事项</p>
          <p className="text-sm mt-1">保持关注新邮件，随时回来查看</p>
        </div>
      )}
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
        <span className="text-gray-400">{open ? '▲' : '▼'}</span>
      </button>
      {open && <div className="px-5 pb-4">{children}</div>}
    </div>
  );
}
