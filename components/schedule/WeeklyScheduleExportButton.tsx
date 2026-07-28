'use client';

/** 导出周日程表(某周内到期节点,按天+跟单人排)→ Excel。本周/下周/上周快捷选。 */

import { useState } from 'react';
import { exportWeeklySchedule } from '@/app/actions/schedule-exports';

function downloadBase64(base64: string, fileName: string) {
  const bytes = atob(base64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  const blob = new Blob([arr], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fileName; a.click();
  URL.revokeObjectURL(url);
}

const WEEKS: Array<{ label: string; offsetDays: number }> = [
  { label: '本周', offsetDays: 0 },
  { label: '下周', offsetDays: 7 },
  { label: '上周', offsetDays: -7 },
];

export function WeeklyScheduleExportButton() {
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  async function download(w: { label: string; offsetDays: number }) {
    setBusy(w.label); setErr('');
    try {
      const anchor = new Date(Date.now() + w.offsetDays * 86400000).toISOString();
      const res = await exportWeeklySchedule(anchor);
      if (res.error || !res.base64) { setErr(res.error || '导出失败'); return; }
      downloadBase64(res.base64, res.fileName || '周日程.xlsx');
    } catch (e: any) {
      setErr(e?.message || '导出失败');
    } finally { setBusy(''); }
  }

  return (
    <div className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-medium text-indigo-800">🗓️ 导出周日程</span>
        {WEEKS.map((w) => (
          <button key={w.label} onClick={() => download(w)} disabled={!!busy}
            className="rounded-lg border border-indigo-300 bg-white px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-50 active:scale-95 transition">
            {busy === w.label ? '导出中…' : w.label}
          </button>
        ))}
      </div>
      <p className="mt-1.5 text-[11px] text-gray-500">当周到期的所有节点,按天+负责人排。管理层导全部跟单,普通账号导自己的。</p>
      {err && <p className="mt-1 text-[11px] text-red-600">{err}</p>}
    </div>
  );
}
