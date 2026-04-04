'use client';

import { useEffect, useState } from 'react';
import { getAgentSuggestions } from '@/app/actions/agent-suggestions';
import { AgentSuggestionCard } from '@/components/AgentSuggestionCard';
import type { AgentSuggestion } from '@/lib/agent/types';

export function OrderAgentSuggestions({ orderId }: { orderId: string }) {
  const [suggestions, setSuggestions] = useState<AgentSuggestion[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getAgentSuggestions(orderId)
      .then(res => setSuggestions(res.data || []))
      .finally(() => setLoading(false));
  }, [orderId]);

  if (loading || suggestions.length === 0) return null;

  return (
    <div className="bg-white rounded-xl border border-indigo-200 shadow-sm overflow-hidden">
      <div className="bg-indigo-50 px-5 py-3 border-b border-indigo-100 flex items-center gap-2">
        <span className="text-lg">🤖</span>
        <h3 className="text-sm font-bold text-indigo-900">Agent 建议</h3>
        <span className="text-xs text-indigo-500">{suggestions.length} 条</span>
      </div>
      <div className="p-4 space-y-3">
        {suggestions.map(s => (
          <AgentSuggestionCard key={s.id} suggestion={s} showOrder={false} />
        ))}
      </div>
    </div>
  );
}
