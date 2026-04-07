'use client';

import { useState } from 'react';
import { executeAgentAction, dismissAgentAction, rollbackAgentAction } from '@/app/actions/agent-execute';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ACTION_CONFIG } from '@/lib/agent/types';
import type { AgentSuggestion } from '@/lib/agent/types';

const SEVERITY_STYLES = {
  high: { bg: 'bg-red-50', border: 'border-red-200', badge: 'bg-red-100 text-red-700', dot: 'bg-red-500' },
  medium: { bg: 'bg-amber-50', border: 'border-amber-200', badge: 'bg-amber-100 text-amber-700', dot: 'bg-amber-500' },
  low: { bg: 'bg-blue-50', border: 'border-blue-200', badge: 'bg-blue-100 text-blue-700', dot: 'bg-blue-500' },
};

export function AgentSuggestionCard({ suggestion, showOrder = true }: {
  suggestion: AgentSuggestion;
  showOrder?: boolean;
}) {
  const router = useRouter();
  const [status, setStatus] = useState(suggestion.status);
  const [executing, setExecuting] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState('');

  const config = ACTION_CONFIG[suggestion.actionType];
  const style = SEVERITY_STYLES[suggestion.severity];

  async function handleExecute() {
    // 需要确认？
    if (config.confirmMessage && !showConfirm) {
      setShowConfirm(true);
      return;
    }

    setExecuting(true);
    setError('');
    setShowConfirm(false);

    const result = await executeAgentAction(suggestion.id);
    if (result.error) {
      setError(result.error);
    } else {
      setStatus('executed');
      router.refresh();
    }
    setExecuting(false);
  }

  async function handleDismiss() {
    setExecuting(true);
    await dismissAgentAction(suggestion.id);
    setStatus('dismissed');
    setExecuting(false);
  }

  async function handleRollback() {
    setExecuting(true);
    setError('');
    const result = await rollbackAgentAction(suggestion.id);
    if (result.error) {
      setError(result.error);
    } else {
      setStatus('pending');
      router.refresh();
    }
    setExecuting(false);
  }

  // 已处理的建议简化显示
  if (status === 'executed') {
    return (
      <div className="flex items-center justify-between p-3 bg-green-50 rounded-lg border border-green-200 text-sm">
        <span className="text-green-700">✅ {suggestion.title}</span>
        {suggestion.canRollback && (
          <button onClick={handleRollback} disabled={executing}
            className="text-xs text-gray-400 hover:text-red-500 disabled:opacity-50">
            撤销
          </button>
        )}
      </div>
    );
  }
  if (status === 'dismissed') {
    return (
      <div className="p-3 bg-gray-50 rounded-lg border border-gray-200 text-sm text-gray-400">
        已忽略：{suggestion.title}
      </div>
    );
  }

  return (
    <div className={`rounded-xl border p-4 ${style.bg} ${style.border}`}>
      {/* 头部 */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-base">{config.icon}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${style.badge}`}>
              {suggestion.severity === 'high' ? '紧急' : suggestion.severity === 'medium' ? '建议' : '提示'}
            </span>
            {showOrder && suggestion.orderNo && (
              <Link href={`/orders/${suggestion.orderId}?from=/ceo`} className="text-xs text-indigo-600 hover:underline">
                {suggestion.orderNo}
              </Link>
            )}
          </div>
          <p className="text-sm font-medium text-gray-900">{suggestion.title}</p>
          <p className="text-xs text-gray-600 mt-1">{suggestion.description}</p>
          {suggestion.reason && (
            <p className="text-xs text-gray-500 mt-1 italic">💡 {suggestion.reason}</p>
          )}
        </div>
      </div>

      {/* 确认弹窗 */}
      {showConfirm && (
        <div className="mt-3 p-3 bg-white rounded-lg border border-gray-300">
          <p className="text-sm text-gray-800 mb-2">{config.confirmMessage}</p>
          <div className="flex gap-2">
            <button onClick={handleExecute} disabled={executing}
              className="px-3 py-1.5 text-xs rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
              确认执行
            </button>
            <button onClick={() => setShowConfirm(false)}
              className="px-3 py-1.5 text-xs rounded-lg border border-gray-300 text-gray-600">
              取消
            </button>
          </div>
        </div>
      )}

      {/* 错误 */}
      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}

      {/* 操作按钮 */}
      {!showConfirm && (
        <div className="flex gap-2 mt-3">
          <button onClick={handleExecute} disabled={executing}
            className="px-4 py-2 text-xs font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors">
            {executing ? '执行中...' : config.buttonLabel}
          </button>
          <button onClick={handleDismiss} disabled={executing}
            className="px-3 py-2 text-xs text-gray-500 hover:text-gray-700 hover:bg-white rounded-lg transition-colors">
            忽略
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 批量展示 Agent 建议（按订单分组）
 */
export function AgentSuggestionsPanel({ suggestions, title, showOrder }: {
  suggestions: AgentSuggestion[];
  title?: string;
  showOrder?: boolean;
}) {
  if (!suggestions || suggestions.length === 0) return null;

  // 按订单分组
  const grouped = new Map<string, { orderNo: string; orderId: string; items: AgentSuggestion[] }>();
  for (const s of suggestions) {
    const key = s.orderId || 'unknown';
    const existing = grouped.get(key);
    if (existing) {
      existing.items.push(s);
    } else {
      grouped.set(key, {
        orderNo: s.orderNo || '未关联订单',
        orderId: s.orderId || '',
        items: [s],
      });
    }
  }

  // 按建议数量排序（多的在前）
  const orderGroups = Array.from(grouped.values()).sort((a, b) => b.items.length - a.items.length);

  // 计算最高严重度
  const maxSev = (items: AgentSuggestion[]) => {
    if (items.some(i => i.severity === 'high')) return 'high';
    if (items.some(i => i.severity === 'medium')) return 'medium';
    return 'low';
  };

  const sevColor = (sev: string) => {
    if (sev === 'high') return 'bg-red-100 text-red-700';
    if (sev === 'medium') return 'bg-amber-100 text-amber-700';
    return 'bg-blue-100 text-blue-700';
  };

  return (
    <div className="bg-white rounded-xl border border-indigo-200 shadow-sm overflow-hidden">
      {title && (
        <div className="bg-indigo-50 px-5 py-3 border-b border-indigo-100 flex items-center gap-2">
          <span className="text-lg">🤖</span>
          <h2 className="text-sm font-bold text-indigo-900">{title}</h2>
          <span className="text-xs text-indigo-500 ml-auto">{orderGroups.length} 个订单 · {suggestions.length} 条建议</span>
        </div>
      )}
      <div className="p-4 space-y-3">
        {orderGroups.map(group => {
          const sev = maxSev(group.items);
          return (
            <details key={group.orderId} className="group rounded-xl border border-gray-200 overflow-hidden">
              <summary className="cursor-pointer px-4 py-3 bg-gray-50 hover:bg-gray-100 flex items-center justify-between list-none">
                <div className="flex items-center gap-2">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${sevColor(sev)}`}>
                    {sev === 'high' ? '紧急' : sev === 'medium' ? '建议' : '提示'}
                  </span>
                  <Link href={`/orders/${group.orderId}?from=/ceo`} className="font-semibold text-indigo-700 hover:underline text-sm">
                    {group.orderNo}
                  </Link>
                  <span className="text-xs text-gray-500">{group.items.length} 条建议</span>
                </div>
                <span className="text-xs text-indigo-500 flex items-center gap-1">
                  <span className="group-open:hidden">▼ 展开</span>
                  <span className="hidden group-open:inline">▲ 收起</span>
                </span>
              </summary>
              <div className="p-3 space-y-2 bg-white">
                {group.items.map(s => (
                  <AgentSuggestionCard key={s.id} suggestion={s} showOrder={false} />
                ))}
              </div>
            </details>
          );
        })}
      </div>
    </div>
  );
}
