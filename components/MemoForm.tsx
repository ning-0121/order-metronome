'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { createMemo, matchOrdersFromText } from '@/app/actions/memos';
import type { OrderMatch } from '@/app/actions/memos';
import { useRouter } from 'next/navigation';

export function MemoForm() {
  const router = useRouter();
  const [content, setContent] = useState('');
  const [remindAt, setRemindAt] = useState('');
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);

  // 订单匹配状态
  const [matches, setMatches] = useState<OrderMatch[]>([]);
  const [matching, setMatching] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<OrderMatch | null>(null);
  const [selectedMilestoneId, setSelectedMilestoneId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastMatchedText = useRef('');

  // 防抖检测订单
  const detectOrders = useCallback((text: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    // 文本太短或被用户关闭提示
    if (text.trim().length < 5) {
      setMatches([]);
      return;
    }

    // 内容没变化不重复请求
    if (text === lastMatchedText.current) return;

    debounceRef.current = setTimeout(async () => {
      lastMatchedText.current = text;
      setMatching(true);
      try {
        const result = await matchOrdersFromText(text);
        setMatches(result.data);
        // 新匹配结果出来时重置 dismissed
        if (result.data.length > 0) setDismissed(false);
      } catch {
        // 静默失败，不影响备忘录正常使用
      } finally {
        setMatching(false);
      }
    }, 800);
  }, []);

  // 清理 debounce timer
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  function handleContentChange(text: string) {
    setContent(text);
    detectOrders(text);
  }

  function handleSelectOrder(order: OrderMatch) {
    setSelectedOrder(order);
    setSelectedMilestoneId(null);
  }

  function handleCancelLink() {
    setSelectedOrder(null);
    setSelectedMilestoneId(null);
    setDismissed(true);
  }

  function handleRemoveLink() {
    setSelectedOrder(null);
    setSelectedMilestoneId(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim()) return;

    setLoading(true);
    const result = await createMemo(
      content.trim(),
      remindAt || undefined,
      selectedOrder?.order_id,
      selectedMilestoneId || undefined,
      selectedOrder?.order_no,
    );
    if (result.error) {
      alert(result.error);
    } else {
      setContent('');
      setRemindAt('');
      setShowForm(false);
      setMatches([]);
      setSelectedOrder(null);
      setSelectedMilestoneId(null);
      setDismissed(false);
      lastMatchedText.current = '';
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

  const showMatchBar = !dismissed && !selectedOrder && matches.length > 0;

  const formatDueDate = (iso: string | null) => {
    if (!iso) return '未设定';
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };

  const statusLabel = (s: string) => {
    const map: Record<string, string> = { pending: '未开始', in_progress: '进行中', blocked: '阻塞', overdue: '逾期' };
    return map[s] || s;
  };

  return (
    <form onSubmit={handleSubmit} className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-4 space-y-3">
      <textarea
        value={content}
        onChange={(e) => handleContentChange(e.target.value)}
        placeholder="输入备忘内容...（可直接粘贴包含订单号的消息）"
        rows={3}
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white text-gray-900 placeholder-gray-400 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
        autoFocus
      />

      {/* 检测中提示 */}
      {matching && (
        <div className="text-xs text-gray-400 flex items-center gap-1.5">
          <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          识别订单信息中...
        </div>
      )}

      {/* 匹配到订单 — 提示条 */}
      {showMatchBar && (
        <div className="space-y-1.5">
          {matches.map((order) => (
            <div
              key={order.order_id}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-50 border border-blue-200 text-sm"
            >
              <span className="text-blue-500 flex-shrink-0">🔗</span>
              <span className="text-blue-800 flex-1 min-w-0 truncate">
                检测到订单 <span className="font-medium">{order.order_no}</span>
                {order.customer_name && <span className="text-blue-600"> ({order.customer_name})</span>}
              </span>
              <button
                type="button"
                onClick={() => handleSelectOrder(order)}
                className="flex-shrink-0 px-2.5 py-1 rounded-md bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 transition-colors"
              >
                关联此订单
              </button>
              <button
                type="button"
                onClick={() => setDismissed(true)}
                className="flex-shrink-0 text-blue-300 hover:text-blue-500"
                title="忽略"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 已选订单 — 关卡选择 */}
      {selectedOrder && (
        <div className="rounded-lg border border-green-200 bg-green-50/50 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-green-600">✓</span>
              <span className="text-green-800 font-medium">
                已关联 {selectedOrder.order_no}
                {selectedOrder.customer_name && ` (${selectedOrder.customer_name})`}
              </span>
            </div>
            <button
              type="button"
              onClick={handleRemoveLink}
              className="text-xs text-green-500 hover:text-red-500 transition-colors"
            >
              取消关联
            </button>
          </div>

          {selectedOrder.milestones.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-gray-500">关联到哪个执行环节？（可选，不选则仅关联订单）</p>
              <div className="grid gap-1">
                {selectedOrder.milestones.map((m) => (
                  <label
                    key={m.id}
                    className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs cursor-pointer transition-colors ${
                      selectedMilestoneId === m.id
                        ? 'bg-green-100 border border-green-300 text-green-800'
                        : 'bg-white border border-gray-200 text-gray-700 hover:border-green-300'
                    }`}
                  >
                    <input
                      type="radio"
                      name="milestone"
                      value={m.id}
                      checked={selectedMilestoneId === m.id}
                      onChange={() => setSelectedMilestoneId(selectedMilestoneId === m.id ? null : m.id)}
                      className="sr-only"
                    />
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                      m.status === 'in_progress' ? 'bg-blue-500' :
                      m.status === 'overdue' ? 'bg-red-500' :
                      m.status === 'blocked' ? 'bg-amber-500' :
                      'bg-gray-300'
                    }`} />
                    <span className="font-medium">{m.name}</span>
                    <span className="text-gray-400">
                      计划 {formatDueDate(m.due_at)} · {statusLabel(m.status)}
                    </span>
                    {selectedMilestoneId === m.id && (
                      <svg className="w-3.5 h-3.5 text-green-600 ml-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

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
            onClick={() => { setShowForm(false); setContent(''); setRemindAt(''); setMatches([]); setSelectedOrder(null); setSelectedMilestoneId(null); setDismissed(false); lastMatchedText.current = ''; }}
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
