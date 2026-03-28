'use client';

import { useState, useEffect } from 'react';
import { getSmartInsights, type SmartInsight } from '@/app/actions/smart-insights';

interface Props {
  customerName?: string;
  factoryName?: string;
  orderType?: string;
}

const SEVERITY_STYLES = {
  high: 'border-red-200 bg-red-50',
  medium: 'border-amber-200 bg-amber-50',
  low: 'border-blue-200 bg-blue-50',
};

export function SmartInsightsPanel({ customerName, factoryName, orderType }: Props) {
  const [insights, setInsights] = useState<SmartInsight[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    if (!customerName && !factoryName) {
      setInsights([]);
      return;
    }
    setLoading(true);
    getSmartInsights({ customerName, factoryName, orderType }).then(res => {
      setInsights(res.data);
      setLoading(false);
    });
  }, [customerName, factoryName, orderType]);

  if (!customerName && !factoryName) return null;
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-gray-400 py-2">
        <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        AI 智脑分析中...
      </div>
    );
  }
  if (insights.length === 0) return null;

  return (
    <div className="rounded-xl border border-indigo-200 bg-indigo-50/30 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-indigo-50/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-lg">🧠</span>
          <span className="text-sm font-semibold text-indigo-800">AI 智脑提醒</span>
          <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-600">{insights.length} 条</span>
        </div>
        <svg className={`w-4 h-4 text-indigo-400 transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-2">
          {insights.map((insight, i) => (
            <div key={i} className={`rounded-lg border p-3 ${SEVERITY_STYLES[insight.severity]}`}>
              <div className="flex items-start gap-2">
                <span className="text-base flex-shrink-0">{insight.icon}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800">{insight.title}</p>
                  <p className="text-xs text-gray-600 mt-0.5 leading-relaxed">{insight.detail}</p>
                  <p className="text-[10px] text-gray-400 mt-1">来源：{insight.source}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
