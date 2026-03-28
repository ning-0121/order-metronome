'use client';

import { useState } from 'react';
import { toggleMemoDone, deleteMemo } from '@/app/actions/memos';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

interface MemoItemProps {
  memo: {
    id: string;
    content: string;
    remind_at: string | null;
    is_done: boolean;
    created_at: string;
    order_id?: string | null;
    linked_order_no?: string | null;
    milestone_id?: string | null;
    milestone_name?: string | null;
    milestone_due_at?: string | null;
  };
}

export function MemoItem({ memo }: MemoItemProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const isRemindDue = memo.remind_at && !memo.is_done && new Date(memo.remind_at) <= new Date();

  async function handleToggle() {
    setLoading(true);
    await toggleMemoDone(memo.id);
    router.refresh();
    setLoading(false);
  }

  async function handleDelete() {
    if (!confirm('确定删除此备忘？')) return;
    setLoading(true);
    await deleteMemo(memo.id);
    router.refresh();
    setLoading(false);
  }

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };

  return (
    <div
      className={`flex items-start gap-3 p-3 rounded-xl border transition-colors ${
        isRemindDue
          ? 'border-amber-300 bg-amber-50/50'
          : memo.is_done
          ? 'border-gray-100 bg-gray-50/50 opacity-60'
          : 'border-gray-200 bg-white'
      }`}
    >
      <button
        onClick={handleToggle}
        disabled={loading}
        className={`mt-0.5 flex-shrink-0 w-5 h-5 rounded border-2 transition-colors ${
          memo.is_done
            ? 'bg-green-500 border-green-500 text-white'
            : 'border-gray-300 hover:border-indigo-500'
        }`}
      >
        {memo.is_done && (
          <svg className="w-full h-full" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
          </svg>
        )}
      </button>

      <div className="flex-1 min-w-0">
        <p className={`text-sm ${memo.is_done ? 'line-through text-gray-400' : 'text-gray-900'}`}>
          {memo.content}
        </p>
        <div className="flex items-center gap-3 mt-1 flex-wrap">
          {/* 关联订单标签 */}
          {memo.order_id && memo.linked_order_no && (
            <Link
              href={`/orders/${memo.order_id}`}
              className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 transition-colors"
            >
              <span>🔗</span>
              <span className="font-medium">{memo.linked_order_no}</span>
              {memo.milestone_name && (
                <span className="text-blue-400">
                  · {memo.milestone_name}
                  {memo.milestone_due_at && ` (${formatDate(memo.milestone_due_at)})`}
                </span>
              )}
            </Link>
          )}
          {memo.remind_at && (
            <span className={`text-xs ${isRemindDue ? 'text-amber-700 font-medium' : 'text-gray-400'}`}>
              {isRemindDue ? '🔔 ' : '⏰ '}
              {formatTime(memo.remind_at)}
            </span>
          )}
          <span className="text-xs text-gray-300">
            创建于 {formatTime(memo.created_at)}
          </span>
        </div>
      </div>

      <button
        onClick={handleDelete}
        disabled={loading}
        className="flex-shrink-0 text-gray-300 hover:text-red-500 transition-colors"
        title="删除"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
