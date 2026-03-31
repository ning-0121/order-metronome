'use client';

import { useState, useEffect } from 'react';
import { getContextualAIAdvice, type AIAdvice } from '@/app/actions/smart-insights';

interface Props {
  scene: 'dashboard' | 'order_detail' | 'milestone_action';
  orderId?: string;
  milestoneStepKey?: string;
  contextData?: string; // 调用方预组装的上下文
  compact?: boolean; // 紧凑模式（节点操作内嵌）
}

export function AIAdviceBox({ scene, orderId, milestoneStepKey, contextData, compact = false }: Props) {
  const [advice, setAdvice] = useState<AIAdvice | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    if (!contextData || contextData.length < 20) return;
    setLoading(true);
    getContextualAIAdvice({ scene, orderId, milestoneStepKey, contextData })
      .then(res => { setAdvice(res.data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [scene, orderId, milestoneStepKey, contextData]);

  if (!contextData || contextData.length < 20) return null;

  if (loading) {
    return (
      <div className={`flex items-center gap-2 ${compact ? 'py-2' : 'py-3'} text-xs text-purple-400`}>
        <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        AI 正在分析...
      </div>
    );
  }

  if (!advice) return null;

  const severityStyles = {
    high: 'border-red-200 from-red-50 to-orange-50',
    medium: 'border-purple-200 from-purple-50 to-indigo-50',
    low: 'border-blue-200 from-blue-50 to-indigo-50',
  };

  if (compact) {
    return (
      <div className={`rounded-lg border bg-gradient-to-r p-3 ${severityStyles[advice.severity]}`}>
        <div className="flex items-start gap-2">
          <span className="text-sm">🤖</span>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-gray-800">{advice.advice}</p>
            {advice.tips.length > 0 && (
              <ul className="mt-1 space-y-0.5">
                {advice.tips.map((tip, i) => (
                  <li key={i} className="text-xs text-gray-600">· {tip}</li>
                ))}
              </ul>
            )}
          </div>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-600 font-medium flex-shrink-0">AI</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`rounded-xl border bg-gradient-to-r overflow-hidden ${severityStyles[advice.severity]}`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-white/30 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-lg">🤖</span>
          <span className="text-sm font-semibold text-gray-800">AI 建议</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-600 font-medium">Claude</span>
        </div>
        <svg className={`w-4 h-4 text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && (
        <div className="px-4 pb-4">
          <p className="text-sm font-medium text-gray-900 mb-2">{advice.advice}</p>
          {advice.tips.length > 0 && (
            <ul className="space-y-1.5">
              {advice.tips.map((tip, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-gray-700">
                  <span className="text-purple-500 flex-shrink-0 mt-0.5">→</span>
                  <span>{tip}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
