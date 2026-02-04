'use client';

import { useState } from 'react';
import { addExecutionNote } from '@/app/actions/milestones';
import { useRouter } from 'next/navigation';

export function ExecutionNoteForm({
  milestoneId,
  onDone,
}: {
  milestoneId: string;
  onDone?: () => void;
}) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [saveAsMemory, setSaveAsMemory] = useState(false);
  const [category, setCategory] = useState<'general' | 'delay' | 'quality' | 'logistics' | 'fabric_quality' | 'packaging' | 'plus_size_stretch'>('general');
  const [riskLevel, setRiskLevel] = useState<'low' | 'medium' | 'high'>('medium');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const result = await addExecutionNote(milestoneId, note, saveAsMemory, category, riskLevel);
    if (result.error) {
      setError(result.error);
    } else {
      setNote('');
      setSaveAsMemory(false);
      router.refresh();
      onDone?.();
    }
    setLoading(false);
  }

  return (
    <div className="bg-gray-50 p-4 rounded-lg border border-gray-200">
      <h4 className="font-semibold text-gray-900 mb-2">执行备注</h4>
      <form onSubmit={handleSubmit} className="space-y-3">
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="记录执行中的注意事项、客户偏好、风险点等…"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-gray-900 placeholder-gray-500 text-sm min-h-[80px]"
          rows={3}
        />
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={saveAsMemory}
            onChange={(e) => setSaveAsMemory(e.target.checked)}
            className="rounded border-gray-300"
          />
          保存为客户记忆（该客户在后续订单中会看到此条提示）
        </label>
        {saveAsMemory && (
          <div className="flex flex-wrap gap-3 text-sm">
            <span className="text-gray-600">分类:</span>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as any)}
              className="rounded border border-gray-300 px-2 py-1 text-gray-900"
            >
              <option value="general">综合</option>
              <option value="delay">交期</option>
              <option value="quality">质量</option>
              <option value="logistics">物流</option>
              <option value="fabric_quality">面料/品质</option>
              <option value="packaging">包装</option>
              <option value="plus_size_stretch">大码/弹力</option>
            </select>
            <span className="text-gray-600">风险:</span>
            <select
              value={riskLevel}
              onChange={(e) => setRiskLevel(e.target.value as any)}
              className="rounded border border-gray-300 px-2 py-1 text-gray-900"
            >
              <option value="low">低</option>
              <option value="medium">中</option>
              <option value="high">高</option>
            </select>
          </div>
        )}
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <button
          type="submit"
          disabled={loading || !note.trim()}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-white text-sm hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? '提交中…' : '提交备注'}
        </button>
      </form>
    </div>
  );
}
