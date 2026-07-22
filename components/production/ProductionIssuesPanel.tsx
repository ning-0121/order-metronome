'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  createProductionIssue,
  listProductionIssues,
  resolveProductionIssue,
  type ProductionIssue,
} from '@/app/actions/production-issues';

const CATEGORY_OPTIONS = [
  { v: 'material', label: '原辅料' },
  { v: 'factory', label: '工厂/排产' },
  { v: 'quality', label: '质量' },
  { v: 'packing', label: '包装/装箱' },
  { v: 'delivery', label: '交期' },
  { v: 'other', label: '其他' },
];
const SEVERITY_CFG: Record<string, { label: string; cls: string }> = {
  high: { label: '紧急', cls: 'bg-red-100 text-red-700' },
  normal: { label: '一般', cls: 'bg-amber-100 text-amber-700' },
  low: { label: '较低', cls: 'bg-gray-100 text-gray-600' },
};

export function ProductionIssuesPanel({ orderId, canWrite }: { orderId: string; canWrite: boolean }) {
  const [issues, setIssues] = useState<ProductionIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [showResolved, setShowResolved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  // 表单
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [category, setCategory] = useState('material');
  const [severity, setSeverity] = useState<'low' | 'normal' | 'high'>('normal');
  const [remindAt, setRemindAt] = useState('');   // datetime-local

  const load = useCallback(async () => {
    setLoading(true);
    const res = await listProductionIssues({ order_id: orderId, status: showResolved ? 'all' : 'open' });
    if (res.error) setErr(res.error);
    else setIssues(res.data || []);
    setLoading(false);
  }, [orderId, showResolved]);

  useEffect(() => { load(); }, [load]);

  async function submit() {
    if (!title.trim()) { setErr('请填写问题'); return; }
    setSaving(true); setErr('');
    const res = await createProductionIssue({
      order_id: orderId,
      title, description: desc, category, severity,
      remind_at: remindAt ? new Date(remindAt).toISOString() : null,
    });
    setSaving(false);
    if (res.error) { setErr(res.error); return; }
    setTitle(''); setDesc(''); setRemindAt(''); setSeverity('normal');
    load();
  }

  async function resolve(id: string) {
    const note = prompt('怎么解决的?(可留空)') ?? '';
    const res = await resolveProductionIssue(id, note);
    if (res.error) { alert(res.error); return; }
    load();
  }

  const openCount = issues.filter(i => i.status === 'open').length;

  return (
    <div className="mt-6 rounded-xl border border-gray-200 bg-white">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <span className="text-base font-semibold text-gray-900">📋 问题记录</span>
          {openCount > 0 && <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">{openCount} 待跟进</span>}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-gray-500">
          <input type="checkbox" checked={showResolved} onChange={e => setShowResolved(e.target.checked)} />
          显示已解决
        </label>
      </div>

      {/* 记录新问题 */}
      {canWrite && (
        <div className="px-4 py-3 border-b border-gray-100 bg-gray-50/60 space-y-2">
          <input
            value={title} onChange={e => setTitle(e.target.value)}
            placeholder="记一个问题(如:XX面料还没到 / 工厂说要拖 3 天 / 中查发现色差)"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
          />
          <div className="flex flex-wrap gap-2 items-center">
            <select value={category} onChange={e => setCategory(e.target.value)} className="rounded-lg border border-gray-200 px-2 py-1.5 text-xs">
              {CATEGORY_OPTIONS.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
            </select>
            <select value={severity} onChange={e => setSeverity(e.target.value as any)} className="rounded-lg border border-gray-200 px-2 py-1.5 text-xs">
              <option value="low">较低</option>
              <option value="normal">一般</option>
              <option value="high">紧急</option>
            </select>
            <label className="flex items-center gap-1 text-xs text-gray-500">
              ⏰ 提醒我
              <input type="datetime-local" value={remindAt} onChange={e => setRemindAt(e.target.value)}
                className="rounded-lg border border-gray-200 px-2 py-1.5 text-xs" />
            </label>
            <button onClick={submit} disabled={saving}
              className="ml-auto px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
              {saving ? '记录中…' : '+ 记录'}
            </button>
          </div>
          <textarea value={desc} onChange={e => setDesc(e.target.value)} rows={2}
            placeholder="补充说明(可选)"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs" />
          <p className="text-[11px] text-gray-400">设了提醒时间,到点会站内 + 企微提醒你;未解决的问题每天会出现在你的今日待办里。</p>
        </div>
      )}

      {err && <div className="px-4 py-2 text-xs text-red-600 bg-red-50">{err}</div>}

      {/* 列表 */}
      <div className="divide-y divide-gray-50">
        {loading ? (
          <p className="px-4 py-6 text-center text-sm text-gray-400">加载中…</p>
        ) : issues.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-gray-400">还没有记录问题</p>
        ) : issues.map(it => {
          const sev = SEVERITY_CFG[it.severity] || SEVERITY_CFG.normal;
          const resolved = it.status === 'resolved';
          return (
            <div key={it.id} className={`px-4 py-3 ${resolved ? 'opacity-60' : ''}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-[11px] px-1.5 py-0.5 rounded ${sev.cls}`}>{sev.label}</span>
                    {it.category && <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">{CATEGORY_OPTIONS.find(c => c.v === it.category)?.label || it.category}</span>}
                    {resolved && <span className="text-[11px] px-1.5 py-0.5 rounded bg-green-100 text-green-700">已解决</span>}
                    {!resolved && it.remind_at && <span className="text-[11px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-600">⏰ {new Date(it.remind_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>}
                  </div>
                  <p className="text-sm font-medium text-gray-900 mt-1">{it.title}</p>
                  {it.description && <p className="text-xs text-gray-500 mt-0.5 whitespace-pre-wrap">{it.description}</p>}
                  <p className="text-[11px] text-gray-400 mt-1">
                    {it.creator_name || '—'} 记于 {new Date(it.created_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    {resolved && it.resolution_note ? ` · 解决:${it.resolution_note}` : ''}
                  </p>
                </div>
                {canWrite && !resolved && (
                  <button onClick={() => resolve(it.id)}
                    className="shrink-0 px-2.5 py-1 rounded-lg bg-green-50 text-green-700 text-xs font-medium hover:bg-green-100">
                    ✓ 已解决
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
