'use client';

/** 导出单订单日程表(节点×计划日期×负责人×状态)→ Excel,可打印发工厂。 */

import { useState } from 'react';
import { exportOrderSchedule } from '@/app/actions/schedule-exports';

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

export function OrderScheduleExportButton({ orderId, className }: { orderId: string; className?: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function download() {
    setBusy(true); setErr('');
    try {
      const res = await exportOrderSchedule(orderId);
      if (res.error || !res.base64) { setErr(res.error || '导出失败'); return; }
      downloadBase64(res.base64, res.fileName || '订单日程.xlsx');
    } catch (e: any) {
      setErr(e?.message || '导出失败');
    } finally { setBusy(false); }
  }

  return (
    <span className={className}>
      <button onClick={download} disabled={busy}
        className="rounded-lg border border-indigo-300 bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-50 active:scale-95 transition">
        {busy ? '导出中…' : '🗓️ 导出订单日程'}
      </button>
      {err && <p className="mt-1 text-[11px] text-red-600">{err}</p>}
    </span>
  );
}
