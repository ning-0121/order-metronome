'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  SOURCE_LABELS,
  CATEGORY_LABELS,
  RISK_LABELS,
  MEMORY_TEMPLATES,
  type CustomerMemoryCategory,
  type CustomerMemoryRiskLevel,
} from '@/lib/domain/customer-memory';
import { createCustomerMemory } from '@/app/actions/customer-memory';
import { formatDate } from '@/lib/utils/date';

export interface CustomerMemoryItem {
  id: string;
  customer_id: string;
  order_id: string | null;
  source_type: string;
  content: string;
  category: string;
  risk_level: string;
  created_at: string;
  content_json?: any;
}

const TEMPLATE_GROUP_LABELS: Record<string, string> = {
  fabric_quality: '面料/品质',
  packaging: '包装',
  plus_size_stretch: '大码/弹力',
};

const ALL_CATEGORIES = Object.keys(CATEGORY_LABELS) as CustomerMemoryCategory[];

function MemoryItem({ m }: { m: CustomerMemoryItem }) {
  return (
    <li className="rounded border border-gray-200 bg-white p-3 text-sm">
      <div className="flex items-center gap-2 flex-wrap mb-1">
        <span className="text-gray-500 font-medium">
          {SOURCE_LABELS[m.source_type as keyof typeof SOURCE_LABELS] ?? m.source_type}
        </span>
        <span className="text-gray-400">
          {CATEGORY_LABELS[m.category as keyof typeof CATEGORY_LABELS] ?? m.category}
        </span>
        <span
          className={`text-xs px-1.5 py-0.5 rounded ${
            m.risk_level === 'high'
              ? 'bg-red-100 text-red-700'
              : m.risk_level === 'medium'
              ? 'bg-yellow-100 text-yellow-800'
              : 'bg-gray-100 text-gray-600'
          }`}
        >
          {RISK_LABELS[m.risk_level as keyof typeof RISK_LABELS] ?? m.risk_level}
        </span>
        <span className="text-gray-400 text-xs ml-auto">
          {formatDate(m.created_at, 'yyyy-MM-dd HH:mm')}
        </span>
      </div>
      <p className="text-gray-700 whitespace-pre-wrap break-words">{m.content}</p>
    </li>
  );
}

export function CustomerMemoryAssistant({
  memories,
  relevantMemories = [],
  customerName,
  orderId,
}: {
  memories: CustomerMemoryItem[];
  relevantMemories?: CustomerMemoryItem[];
  customerName: string;
  orderId?: string;
}) {
  const router = useRouter();
  const [quickContent, setQuickContent] = useState('');
  const [quickCategory, setQuickCategory] = useState<CustomerMemoryCategory>('general');
  const [quickRisk, setQuickRisk] = useState<CustomerMemoryRiskLevel>('medium');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const hasRelevant = relevantMemories && relevantMemories.length > 0;
  const hasAny = memories && memories.length > 0;

  async function handleQuickAdd(e: React.FormEvent) {
    e.preventDefault();
    const content = quickContent.trim();
    if (!content || !customerName) return;
    setAdding(true);
    setAddError(null);
    const result = await createCustomerMemory({
      customer_id: customerName,
      order_id: orderId ?? null,
      source_type: 'manual',
      content,
      category: quickCategory,
      risk_level: quickRisk,
    });
    if (result.error) {
      setAddError(result.error);
    } else {
      setQuickContent('');
      setQuickCategory('general');
      setQuickRisk('medium');
      router.refresh();
    }
    setAdding(false);
  }

  function useTemplate(t: (typeof MEMORY_TEMPLATES)[0]) {
    setQuickContent(t.content);
    setQuickCategory(t.category);
    setQuickRisk(t.risk_level);
  }

  if (!customerName) return null;

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-4 space-y-4">
      <h3 className="text-lg font-semibold text-gray-900">我的执行助手 · 客户记忆</h3>

      {hasRelevant && (
        <div className="rounded-lg border border-amber-300 bg-amber-100/80 p-3">
          <h4 className="text-sm font-semibold text-amber-900 mb-2 flex items-center gap-1">
            ⚠️ 客户记忆提醒
          </h4>
          <ul className="space-y-2">
            {relevantMemories.map((m) => (
              <MemoryItem key={m.id} m={m} />
            ))}
          </ul>
        </div>
      )}

      {!hasAny && !hasRelevant && (
        <p className="text-gray-600 text-sm">暂无该客户（{customerName}）的历史记忆，可在下方添加或从模板添加。</p>
      )}

      {hasAny && !hasRelevant && (
        <p className="text-gray-600 text-sm">客户「{customerName}」的历史记录，供执行时参考：</p>
      )}

      {hasAny && (
        <div>
          <h4 className="text-sm font-medium text-gray-700 mb-2">全部记忆</h4>
          <ul className="space-y-3 max-h-48 overflow-y-auto">
            {memories.map((m) => (
              <MemoryItem key={m.id} m={m} />
            ))}
          </ul>
        </div>
      )}

      {orderId && (
        <>
          <div className="border-t border-amber-200 pt-3">
            <h4 className="text-sm font-medium text-gray-800 mb-2">快速添加记忆</h4>
            <form onSubmit={handleQuickAdd} className="space-y-2">
              <input
                type="text"
                value={quickContent}
                onChange={(e) => setQuickContent(e.target.value)}
                placeholder="一条简短提醒（可编辑后保存）"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-gray-900 placeholder-gray-500 text-sm"
              />
              <div className="flex flex-wrap gap-3 items-center text-sm">
                <span className="text-gray-600">分类</span>
                <select
                  value={quickCategory}
                  onChange={(e) => setQuickCategory(e.target.value as CustomerMemoryCategory)}
                  className="rounded border border-gray-300 px-2 py-1 text-gray-900"
                >
                  {ALL_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {CATEGORY_LABELS[c]}
                    </option>
                  ))}
                </select>
                <span className="text-gray-600">风险</span>
                <select
                  value={quickRisk}
                  onChange={(e) => setQuickRisk(e.target.value as CustomerMemoryRiskLevel)}
                  className="rounded border border-gray-300 px-2 py-1 text-gray-900"
                >
                  <option value="low">{RISK_LABELS.low}</option>
                  <option value="medium">{RISK_LABELS.medium}</option>
                  <option value="high">{RISK_LABELS.high}</option>
                </select>
                <button
                  type="submit"
                  disabled={adding || !quickContent.trim()}
                  className="px-3 py-1.5 rounded bg-amber-600 text-white text-sm font-medium disabled:opacity-50"
                >
                  {adding ? '保存中…' : '保存为客户记忆'}
                </button>
              </div>
              {addError && <p className="text-red-600 text-sm">{addError}</p>}
            </form>
          </div>

          <div className="border-t border-amber-200 pt-3">
            <h4 className="text-sm font-medium text-gray-800 mb-2">从模板添加</h4>
            <p className="text-gray-600 text-xs mb-2">使用以下建议时可编辑后再保存。</p>
            <div className="space-y-3">
              {(['fabric_quality', 'packaging', 'plus_size_stretch'] as const).map((group) => {
                const list = MEMORY_TEMPLATES.filter((t) => t.group === group);
                if (list.length === 0) return null;
                return (
                  <div key={group}>
                    <span className="text-xs font-medium text-gray-500">{TEMPLATE_GROUP_LABELS[group] ?? group}</span>
                    <ul className="mt-1 space-y-1">
                      {list.map((t) => (
                        <li key={t.id} className="flex items-start gap-2 text-sm">
                          <span className="text-gray-700 flex-1">{t.content}</span>
                          <button
                            type="button"
                            onClick={() => useTemplate(t)}
                            className="shrink-0 px-2 py-0.5 rounded border border-amber-400 text-amber-800 text-xs hover:bg-amber-100"
                          >
                            使用此模板
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
