'use client';

/**
 * 采购单 · 自定义追踪提醒节点面板。
 * 采购加「节点名 + 日期(+备注)」→ cron 到点提醒采购/业务/跟单(见 /api/cron/reminders)。
 * 页面级门禁已限采购/管理员,故此处默认可管理;action 层再次校验角色。
 */

import { useEffect, useState } from 'react';
import {
  listPoReminders, addPoReminder, updatePoReminder, markPoReminderDone, deletePoReminder,
  type PoReminder,
} from '@/app/actions/po-reminders';
import { useDialogs } from '@/components/ui/useDialogs';

const STATUS: Record<string, { label: string; cls: string }> = {
  pending:  { label: '待提醒', cls: 'bg-amber-100 text-amber-700' },
  notified: { label: '已提醒', cls: 'bg-blue-100 text-blue-700' },
  done:     { label: '已完成', cls: 'bg-green-100 text-green-700' },
  cancelled:{ label: '已取消', cls: 'bg-gray-100 text-gray-500' },
};

export function PoRemindersPanel({ poId }: { poId: string }) {
  const { confirm, dialog } = useDialogs();
  const [items, setItems] = useState<PoReminder[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [label, setLabel] = useState('');
  const [remindAt, setRemindAt] = useState('');
  const [note, setNote] = useState('');

  async function load() {
    const res = await listPoReminders(poId);
    if ((res as any).data) setItems((res as any).data);
    setLoading(false);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [poId]);

  const today = new Date().toISOString().slice(0, 10);
  const isOverdue = (r: PoReminder) => r.status === 'pending' && r.remind_at <= today;

  async function add() {
    if (!label.trim()) { await dialog('请填写提醒节点名称'); return; }
    if (!remindAt) { await dialog('请选择提醒日期'); return; }
    setSaving(true);
    const res = await addPoReminder(poId, { label: label.trim(), remind_at: remindAt, note: note.trim() || undefined });
    setSaving(false);
    if ((res as any).error) { await dialog((res as any).error); return; }
    setLabel(''); setRemindAt(''); setNote('');
    load();
  }

  async function done(id: string) {
    const res = await markPoReminderDone(id);
    if ((res as any).error) { await dialog((res as any).error); return; }
    load();
  }

  async function reschedule(r: PoReminder) {
    // 简单改期:用原生 date input 值不方便,走 dialog 输入 YYYY-MM-DD
    const v = window.prompt('改到哪天提醒?(格式 YYYY-MM-DD)', r.remind_at);
    if (!v) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) { await dialog('日期格式应为 YYYY-MM-DD'); return; }
    const res = await updatePoReminder(r.id, { remind_at: v });
    if ((res as any).error) { await dialog((res as any).error); return; }
    load();
  }

  async function remove(id: string) {
    if (!(await confirm('删除这个提醒节点?'))) return;
    const res = await deletePoReminder(id);
    if ((res as any).error) { await dialog((res as any).error); return; }
    load();
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 text-sm font-semibold text-gray-700 flex items-center gap-2">
        ⏰ 追踪提醒
        <span className="text-xs font-normal text-gray-400">到日期系统提醒采购 / 业务 / 跟单</span>
      </div>

      <div className="p-4 space-y-3">
        {/* 添加 */}
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-gray-600 flex flex-col gap-1">
            <span>节点名称</span>
            <input value={label} onChange={e => setLabel(e.target.value)} placeholder="如:催面料到货 / 确认染色进度"
              className="rounded border border-gray-300 px-2 py-1.5 text-sm w-52" />
          </label>
          <label className="text-xs text-gray-600 flex flex-col gap-1">
            <span>提醒日期</span>
            <input type="date" value={remindAt} onChange={e => setRemindAt(e.target.value)}
              className="rounded border border-gray-300 px-2 py-1.5 text-sm" />
          </label>
          <label className="text-xs text-gray-600 flex flex-col gap-1 flex-1 min-w-[140px]">
            <span>备注(可选)</span>
            <input value={note} onChange={e => setNote(e.target.value)} placeholder="给自己/业务的说明"
              className="rounded border border-gray-300 px-2 py-1.5 text-sm w-full" />
          </label>
          <button onClick={add} disabled={saving}
            className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
            {saving ? '添加中…' : '+ 加提醒'}
          </button>
        </div>

        {/* 列表 */}
        {loading ? (
          <p className="text-xs text-gray-400 py-2">加载中…</p>
        ) : items.length === 0 ? (
          <p className="text-xs text-gray-400 py-2 border-2 border-dashed border-gray-100 rounded-lg text-center">
            还没有追踪提醒。加一个「节点 + 日期」,到点系统会提醒你和业务/跟单。
          </p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {items.map(r => (
              <li key={r.id} className="py-2 flex items-center gap-3 text-sm">
                <span className={`shrink-0 px-2 py-0.5 rounded text-[11px] font-medium ${STATUS[r.status]?.cls || 'bg-gray-100 text-gray-500'}`}>
                  {STATUS[r.status]?.label || r.status}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-gray-800 truncate">{r.label}</div>
                  {r.note && <div className="text-xs text-gray-400 truncate">{r.note}</div>}
                </div>
                <span className={`shrink-0 text-xs ${isOverdue(r) ? 'text-red-600 font-semibold' : 'text-gray-500'}`}>
                  {r.remind_at}{isOverdue(r) ? ' ·到期' : ''}
                </span>
                <div className="shrink-0 flex items-center gap-2 text-xs">
                  {r.status !== 'done' && <button onClick={() => done(r.id)} className="text-green-600 hover:underline">完成</button>}
                  <button onClick={() => reschedule(r)} className="text-indigo-600 hover:underline">改期</button>
                  <button onClick={() => remove(r.id)} className="text-red-500 hover:underline">删除</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
