'use client';

import { useState } from 'react';
import { generateAcceptanceInsight } from '@/app/actions/ceo-ai';

interface Props {
  orders: Array<{
    order_no: string;
    customer_name: string;
    order_type: string;
    quantity: number | null;
    factory_date: string | null;
    incoterm: string;
    created_at: string;
  }>;
}

export function CeoInsightButton({ orders }: Props) {
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [cached, setCached] = useState(false);

  async function handleClick() {
    setLoading(true);
    const res = await generateAcceptanceInsight(orders);
    setLoading(false);
    if (res.suggestion) {
      setSuggestion(res.suggestion);
      setCached(!!res.cached);
    } else {
      setSuggestion(res.error || '生成失败，请稍后重试');
    }
  }

  if (!suggestion) {
    return (
      <button
        onClick={handleClick}
        disabled={loading}
        className="mt-2 w-full text-xs bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-medium py-1.5 px-3 rounded-lg transition-colors disabled:opacity-50"
      >
        {loading ? '⏳ AI 分析中...' : '✨ AI 接单建议'}
      </button>
    );
  }

  return (
    <div className="pt-2 border-t border-gray-100">
      <div className="flex items-center justify-between mb-1">
        <p className="text-xs text-indigo-700 font-medium">✨ AI 接单建议</p>
        <div className="flex items-center gap-1">
          {cached && <span className="text-[10px] text-gray-400">缓存</span>}
          <button
            onClick={() => { setSuggestion(null); setCached(false); }}
            className="text-[10px] text-gray-400 hover:text-gray-600"
          >
            重置
          </button>
        </div>
      </div>
      <p className="text-xs text-gray-700 leading-relaxed">{suggestion}</p>
    </div>
  );
}
