'use client';

import { useState, useEffect } from 'react';
import {
  getOrderNotes,
  addOrderNote,
  deleteOrderNote,
  type OrderNote,
} from '@/app/actions/order-notes';

interface Props {
  orderId: string;
  currentUserId?: string;
  isAdmin?: boolean;
}

const CATEGORY_CONFIG: Record<
  OrderNote['category'],
  { label: string; icon: string; color: string }
> = {
  general: { label: '一般', icon: '📝', color: 'bg-gray-50 border-gray-200 text-gray-700' },
  delay: { label: '延期', icon: '⏰', color: 'bg-amber-50 border-amber-200 text-amber-800' },
  quality: { label: '品质', icon: '🔍', color: 'bg-red-50 border-red-200 text-red-800' },
  customer: { label: '客户沟通', icon: '💬', color: 'bg-indigo-50 border-indigo-200 text-indigo-800' },
  internal: { label: '内部协调', icon: '🏢', color: 'bg-purple-50 border-purple-200 text-purple-800' },
  other: { label: '其他', icon: '💡', color: 'bg-blue-50 border-blue-200 text-blue-800' },
};

export function OrderNotesTab({ orderId, currentUserId, isAdmin = false }: Props) {
  const [notes, setNotes] = useState<OrderNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [content, setContent] = useState('');
  const [category, setCategory] = useState<OrderNote['category']>('general');
  const [submitting, setSubmitting] = useState(false);
  const [filterCategory, setFilterCategory] = useState<OrderNote['category'] | 'all'>('all');

  useEffect(() => {
    load();
  }, [orderId]);

  async function load() {
    setLoading(true);
    const res = await getOrderNotes(orderId);
    if (res.data) setNotes(res.data);
    setLoading(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim()) return;
    setSubmitting(true);
    const res = await addOrderNote(orderId, content, category);
    if (res.error) {
      alert(res.error);
    } else {
      setContent('');
      setCategory('general');
      load();
    }
    setSubmitting(false);
  }

  async function handleDelete(noteId: string) {
    if (!confirm('确定删除这条备注？')) return;
    const res = await deleteOrderNote(noteId, orderId);
    if (res.error) alert(res.error);
    else load();
  }

  const filtered =
    filterCategory === 'all' ? notes : notes.filter(n => n.category === filterCategory);

  const countByCategory: Record<string, number> = {};
  for (const n of notes) countByCategory[n.category] = (countByCategory[n.category] || 0) + 1;

  return (
    <div className="space-y-5">
      {/* 新增备注表单 */}
      <form
        onSubmit={handleSubmit}
        className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-4 space-y-3"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-gray-800">📝 添加备注</span>
          <span className="text-xs text-gray-400">— 任何和这个订单相关的事都可以记在这里</span>
        </div>
        <textarea
          value={content}
          onChange={e => setContent(e.target.value)}
          rows={3}
          maxLength={2000}
          placeholder="例如：客户说包装要改成双层纸箱 / 工厂反馈面料到货延迟 3 天 / 下周一提醒跟进 ..."
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white focus:outline-none focus:border-indigo-400"
        />
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-gray-500">类型：</span>
            {(Object.keys(CATEGORY_CONFIG) as OrderNote['category'][]).map(key => (
              <button
                key={key}
                type="button"
                onClick={() => setCategory(key)}
                className={`text-xs px-2.5 py-1 rounded-full border transition-all ${
                  category === key
                    ? CATEGORY_CONFIG[key].color + ' ring-2 ring-offset-1 ring-current'
                    : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50'
                }`}
              >
                {CATEGORY_CONFIG[key].icon} {CATEGORY_CONFIG[key].label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400">{content.length}/2000</span>
            <button
              type="submit"
              disabled={submitting || !content.trim()}
              className="px-4 py-1.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
            >
              {submitting ? '保存中...' : '保存备注'}
            </button>
          </div>
        </div>
      </form>

      {/* 筛选标签 */}
      {notes.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setFilterCategory('all')}
            className={`text-xs px-3 py-1 rounded-full border transition-all ${
              filterCategory === 'all'
                ? 'bg-indigo-600 text-white border-indigo-600'
                : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            全部 ({notes.length})
          </button>
          {(Object.keys(CATEGORY_CONFIG) as OrderNote['category'][])
            .filter(k => countByCategory[k] > 0)
            .map(key => (
              <button
                key={key}
                onClick={() => setFilterCategory(key)}
                className={`text-xs px-3 py-1 rounded-full border transition-all ${
                  filterCategory === key
                    ? CATEGORY_CONFIG[key].color + ' ring-2 ring-offset-1 ring-current'
                    : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                }`}
              >
                {CATEGORY_CONFIG[key].icon} {CATEGORY_CONFIG[key].label} ({countByCategory[key]})
              </button>
            ))}
        </div>
      )}

      {/* 备注列表 */}
      {loading ? (
        <p className="text-center text-sm text-gray-400 py-8">加载中...</p>
      ) : filtered.length === 0 ? (
        <p className="text-center text-sm text-gray-400 py-8">
          {notes.length === 0 ? '暂无备注，先写第一条吧' : '没有符合筛选条件的备注'}
        </p>
      ) : (
        <div className="space-y-3">
          {filtered.map(note => {
            const cfg = CATEGORY_CONFIG[note.category] || CATEGORY_CONFIG.general;
            const canDelete = isAdmin || note.author_user_id === currentUserId;
            return (
              <div
                key={note.id}
                className={`rounded-xl border p-4 ${cfg.color}`}
              >
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm">{cfg.icon}</span>
                    <span className="text-xs font-medium">{cfg.label}</span>
                    <span className="text-xs opacity-70">·</span>
                    <span className="text-xs opacity-80">{note.author_name || '未知'}</span>
                    <span className="text-xs opacity-50">
                      {new Date(note.created_at).toLocaleString('zh-CN', {
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                  {canDelete && (
                    <button
                      onClick={() => handleDelete(note.id)}
                      className="text-xs opacity-50 hover:opacity-100 hover:text-red-600"
                      title="删除"
                    >
                      ✕
                    </button>
                  )}
                </div>
                <p className="text-sm leading-relaxed whitespace-pre-wrap">{note.content}</p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
