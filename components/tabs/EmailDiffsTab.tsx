'use client';

import { useEffect, useState } from 'react';
import { getOrderEmailDiffs, resolveEmailDiff } from '@/app/actions/mail-monitor';

interface Diff {
  id: string;
  mail_inbox_id: string;
  field: string;
  email_value: string | null;
  order_value: string | null;
  severity: 'high' | 'medium' | 'low';
  suggestion: string | null;
  status: 'open' | 'resolved' | 'ignored' | 'false_positive';
  detected_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
}

const SEVERITY: Record<string, { label: string; color: string }> = {
  high: { label: '严重', color: 'bg-red-100 text-red-700 border-red-200' },
  medium: { label: '注意', color: 'bg-amber-100 text-amber-700 border-amber-200' },
  low: { label: '轻微', color: 'bg-gray-100 text-gray-700 border-gray-200' },
};

const STATUS: Record<string, { label: string; color: string }> = {
  open: { label: '待处理', color: 'bg-orange-100 text-orange-700' },
  resolved: { label: '已解决', color: 'bg-green-100 text-green-700' },
  ignored: { label: '已忽略', color: 'bg-gray-100 text-gray-600' },
  false_positive: { label: '误报', color: 'bg-purple-100 text-purple-700' },
};

export function EmailDiffsTab({ orderId }: { orderId: string }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [diffs, setDiffs] = useState<Diff[]>([]);
  const [filter, setFilter] = useState<'all' | 'open'>('open');

  async function load() {
    setLoading(true);
    setError('');
    const res = await getOrderEmailDiffs(orderId);
    if (res.error) setError(res.error);
    else setDiffs(res.data || []);
    setLoading(false);
  }

  useEffect(() => { load(); }, [orderId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleResolve(d: Diff, status: 'resolved' | 'ignored' | 'false_positive') {
    const labels = { resolved: '已解决', ignored: '忽略', false_positive: '误报' };
    const note = prompt(`标记为「${labels[status]}」的备注（可留空）：`) || '';
    const res = await resolveEmailDiff(d.id, status, note);
    if (res.error) { alert(res.error); return; }
    load();
  }

  const visible = filter === 'open'
    ? diffs.filter(d => d.status === 'open')
    : diffs;

  const stats = {
    open: diffs.filter(d => d.status === 'open').length,
    resolved: diffs.filter(d => d.status === 'resolved').length,
    ignored: diffs.filter(d => d.status === 'ignored').length,
    false_positive: diffs.filter(d => d.status === 'false_positive').length,
  };

  return (
    <div>
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">📧 邮件 vs 订单差异</h2>
            <p className="text-xs text-gray-500 mt-1">
              AI 自动比对客户来邮和订单数据，差异会持久化在这里供追溯
            </p>
          </div>
          <div className="flex gap-2 text-xs">
            <button
              onClick={() => setFilter('open')}
              className={`px-3 py-1.5 rounded-lg border ${filter === 'open' ? 'bg-orange-50 border-orange-300 text-orange-700 font-medium' : 'border-gray-200 text-gray-500'}`}
            >
              待处理 ({stats.open})
            </button>
            <button
              onClick={() => setFilter('all')}
              className={`px-3 py-1.5 rounded-lg border ${filter === 'all' ? 'bg-gray-100 border-gray-300 text-gray-700 font-medium' : 'border-gray-200 text-gray-500'}`}
            >
              全部 ({diffs.length})
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {loading ? (
          <p className="text-gray-400 text-center py-8">加载中...</p>
        ) : visible.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-3xl">{filter === 'open' ? '✅' : '📭'}</p>
            <p className="text-gray-500 mt-2">
              {filter === 'open' ? '没有待处理的邮件差异' : '该订单暂无邮件差异记录'}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {visible.map(d => {
              const sev = SEVERITY[d.severity];
              const st = STATUS[d.status];
              return (
                <div key={d.id} className={`p-4 rounded-lg border-2 ${sev.color}`}>
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`px-2 py-0.5 rounded text-[11px] font-medium border ${sev.color}`}>
                        {sev.label}
                      </span>
                      <span className={`px-2 py-0.5 rounded text-[11px] font-medium ${st.color}`}>
                        {st.label}
                      </span>
                      <span className="text-sm font-semibold text-gray-900">{d.field}</span>
                      <span className="text-xs text-gray-500">
                        {new Date(d.detected_at).toLocaleString('zh-CN')}
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3 text-sm bg-white rounded p-3 border border-gray-100">
                    <div>
                      <p className="text-xs text-gray-500 mb-1">📧 邮件中</p>
                      <p className="text-red-700 font-medium">{d.email_value || '—'}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500 mb-1">💼 订单中</p>
                      <p className="text-blue-700 font-medium">{d.order_value || '—'}</p>
                    </div>
                  </div>

                  {d.suggestion && (
                    <p className="text-xs text-gray-600 mt-2 px-3">
                      💡 <span className="font-medium">建议：</span>{d.suggestion}
                    </p>
                  )}

                  {d.resolution_note && (
                    <p className="text-xs text-gray-500 mt-2 px-3 italic">
                      处理备注：{d.resolution_note}
                    </p>
                  )}

                  {d.status === 'open' && (
                    <div className="flex gap-2 mt-3">
                      <button
                        onClick={() => handleResolve(d, 'resolved')}
                        className="text-xs px-3 py-1.5 rounded-lg bg-green-600 text-white hover:bg-green-700"
                      >
                        ✓ 标记已解决
                      </button>
                      <button
                        onClick={() => handleResolve(d, 'ignored')}
                        className="text-xs px-3 py-1.5 rounded-lg bg-white border border-gray-300 text-gray-600 hover:bg-gray-50"
                      >
                        忽略
                      </button>
                      <button
                        onClick={() => handleResolve(d, 'false_positive')}
                        className="text-xs px-3 py-1.5 rounded-lg bg-white border border-purple-300 text-purple-600 hover:bg-purple-50"
                      >
                        AI 误报
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
