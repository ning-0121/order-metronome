'use client';

import { useState } from 'react';
import { createMemo } from '@/app/actions/memos';
import { useRouter } from 'next/navigation';

export function MemoForm() {
  const router = useRouter();
  const [content, setContent] = useState('');
  const [remindAt, setRemindAt] = useState('');
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim()) return;

    setLoading(true);
    const result = await createMemo(content.trim(), remindAt || undefined);
    if (result.error) {
      alert(result.error);
    } else {
      setContent('');
      setRemindAt('');
      setShowForm(false);
      router.refresh();
    }
    setLoading(false);
  }

  if (!showForm) {
    return (
      <button
        onClick={() => setShowForm(true)}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
        新增备忘
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-4 space-y-3">
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="输入备忘内容..."
        rows={2}
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white text-gray-900 placeholder-gray-400 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
        autoFocus
      />
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 text-sm text-gray-600">
          <label htmlFor="remind_at">提醒时间（可选）:</label>
          <input
            id="remind_at"
            type="datetime-local"
            value={remindAt}
            onChange={(e) => setRemindAt(e.target.value)}
            className="rounded-lg border border-gray-300 px-2 py-1 text-sm bg-white text-gray-900"
          />
        </div>
        <div className="flex gap-2 ml-auto">
          <button
            type="button"
            onClick={() => { setShowForm(false); setContent(''); setRemindAt(''); }}
            className="px-3 py-1.5 rounded-lg text-sm text-gray-600 hover:bg-gray-100"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={loading || !content.trim()}
            className="px-4 py-1.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
          >
            {loading ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </form>
  );
}
