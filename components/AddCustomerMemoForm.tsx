'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createCustomerMemory } from '@/app/actions/customer-memory';

/**
 * 客户页「添加经验备忘」表单。Phase 1：手动沉淀客户/品牌经验（如「BK 交期至少 75 天」）。
 * 写入 customer_memory（source_type='manual'，按 customer_name 关联）。
 */
// 客户档案维度（业务员手填，新人交接看全局）
const CATEGORIES: Array<{ value: string; label: string }> = [
  { value: 'brand', label: '客户品牌' },
  { value: 'order_habit', label: '下单习惯' },
  { value: 'sample_confirm', label: '样衣确认' },
  { value: 'pricing', label: '价格/价格演变' },
  { value: 'inspection', label: '验货标准' },
  { value: 'lead_time', label: '订单周期' },
  { value: 'special_requirement', label: '个性化要求' },
  { value: 'payment_behavior', label: '付款行为' },
  { value: 'general', label: '综合' },
];

export function AddCustomerMemoForm({ customerName }: { customerName: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState('');
  const [category, setCategory] = useState('brand');
  const [risk, setRisk] = useState<'high' | 'medium' | 'low'>('medium');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSave() {
    const trimmed = content.trim();
    if (!trimmed) return;
    setSaving(true);
    setError('');
    const res = await createCustomerMemory({
      customer_id: customerName,
      source_type: 'manual',
      content: trimmed,
      category: category as any,
      risk_level: risk,
    });
    if (res.error) {
      setError(res.error);
      setSaving(false);
      return;
    }
    setContent('');
    setOpen(false);
    setSaving(false);
    router.refresh();
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
      >
        ＋ 添加经验备忘
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-indigo-200 bg-indigo-50/40 p-2 space-y-2">
      <textarea
        value={content}
        onChange={e => setContent(e.target.value)}
        placeholder="例：品牌 BK 交期至少 75 天；Cotton Candy 60 天"
        rows={2}
        autoFocus
        className="w-full rounded border border-gray-300 px-2 py-1 text-xs focus:border-indigo-500 focus:outline-none"
      />
      <div className="flex items-center gap-2">
        <select value={category} onChange={e => setCategory(e.target.value)} className="rounded border border-gray-300 px-1.5 py-1 text-xs">
          {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        <select value={risk} onChange={e => setRisk(e.target.value as any)} className="rounded border border-gray-300 px-1.5 py-1 text-xs">
          <option value="high">高风险</option>
          <option value="medium">中风险</option>
          <option value="low">低风险</option>
        </select>
        <button type="button" onClick={handleSave} disabled={saving || !content.trim()}
          className="rounded bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
          {saving ? '保存中…' : '保存'}
        </button>
        <button type="button" onClick={() => { setOpen(false); setError(''); }}
          className="px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 rounded">取消</button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
