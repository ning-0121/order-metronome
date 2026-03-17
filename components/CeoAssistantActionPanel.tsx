'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

interface CEOActionItem {
  id: string;
  kind: 'overdue' | 'blocked_24h' | 'pending_delay' | 'red_risk_soon';
  order_id: string;
  order_no: string;
  milestone_id: string;
  reason: string;
  suggestion: string;
}

interface CeoAssistantActionPanelProps {
  items: CEOActionItem[];
  pendingDelayCount: number;
  summaryText: string;
}

const KIND_LABELS: Record<CEOActionItem['kind'], string> = {
  overdue: '逾期',
  blocked_24h: '阻塞超24小时',
  pending_delay: '延期待批',
  red_risk_soon: '即将红色风险',
};

export function CeoAssistantActionPanel({
  items,
  pendingDelayCount,
  summaryText,
}: CeoAssistantActionPanelProps) {
  const router = useRouter();
  const [nudging, setNudging] = useState<Record<string, boolean>>({});

  async function handleNudge(milestoneId: string) {
    setNudging((prev) => ({ ...prev, [milestoneId]: true }));

    try {
      const response = await fetch('/api/nudge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ milestone_id: milestoneId }),
      });

      const data = await response.json();

      if (!response.ok) {
        alert(data.error || '发送提醒失败');
      } else {
        alert('提醒已发送');
        router.refresh();
      }
    } catch (error: any) {
      alert('错误: ' + error.message);
    } finally {
      setNudging((prev) => ({ ...prev, [milestoneId]: false }));
    }
  }

  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50 p-5 space-y-3">
      <div className="flex flex-col md:flex-row md:items-baseline md:justify-between gap-2">
        <div>
          <h2 className="text-2xl font-semibold text-gray-900">CEO 助手 · 今日行动建议</h2>
          <p className="text-sm text-gray-700 mt-1">
            基于执行节点、延期申请与订单风险，筛选出最值得你现在处理的事项。
          </p>
        </div>
      </div>

      {items && items.length > 0 ? (
        <div className="space-y-2">
          {items.map((item) => {
            const isNudging = nudging[item.milestone_id] || false;
            return (
              <div
                key={item.id}
                className="bg-white rounded-lg border border-blue-200 p-3 flex flex-col md:flex-row md:items-start md:justify-between gap-3"
              >
                <div className="flex-1 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-gray-900">
                      订单：
                      <Link
                        href={`/orders/${item.order_id}`}
                        className="text-blue-600 hover:text-blue-700 ml-1"
                      >
                        {item.order_no}
                      </Link>
                    </span>
                    <span
                      className={`text-xs px-1.5 py-0.5 rounded-full border ${
                        item.kind === 'overdue'
                          ? 'bg-red-50 text-red-700 border-red-200'
                          : item.kind === 'blocked_24h'
                          ? 'bg-orange-50 text-orange-700 border-orange-200'
                          : item.kind === 'pending_delay'
                          ? 'bg-yellow-50 text-yellow-700 border-yellow-200'
                          : 'bg-purple-50 text-purple-700 border-purple-200'
                      }`}
                    >
                      {KIND_LABELS[item.kind]}
                    </span>
                  </div>
                  <p className="text-sm text-gray-800">{item.reason}</p>
                  <p className="text-xs text-gray-600">建议：{item.suggestion}</p>
                </div>
                <div className="flex flex-row md:flex-col gap-2 md:items-end">
                  <Link
                    href={`/orders/${item.order_id}#milestone-${item.milestone_id}`}
                    className="inline-flex items-center justify-center rounded-md border border-blue-500 px-3 py-1.5 text-sm font-medium text-blue-600 hover:bg-blue-50"
                  >
                    查看
                  </Link>
                  <button
                    type="button"
                    onClick={() => handleNudge(item.milestone_id)}
                    disabled={isNudging}
                    className="inline-flex items-center justify-center rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {isNudging ? '提醒中…' : '📧 提醒'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-gray-700">
          目前没有紧急风险或待处理节点，系统运行平稳。
        </p>
      )}

      <div className="border-t border-blue-200 pt-3 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div className="text-sm text-gray-800">
          <span className="font-semibold">今日总结：</span>
          <span>{summaryText}</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-sm text-gray-700">
            待你决策：<span className="font-semibold">{pendingDelayCount}</span> 条延期申请
          </div>
          <a
            href="#delay-approvals"
            className="inline-flex items-center justify-center rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
          >
            立即处理
          </a>
        </div>
      </div>
    </div>
  );
}

