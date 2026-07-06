'use client';

/** 业务员一键导出剩余货物(跨订单,精确到款色 + 所属订单 + 生产工厂)。 */

import { useState } from 'react';
import { exportLeftoverGoods } from '@/app/actions/leftover-goods';

export function LeftoverExportButton() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function download() {
    setBusy(true); setErr('');
    try {
      const res = await exportLeftoverGoods();
      if (res.error || !res.base64) { setErr(res.error || '导出失败'); return; }
      const bytes = atob(res.base64);
      const arr = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
      const blob = new Blob([arr], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = res.fileName || '剩余货物清单.xlsx';
      a.click();
      URL.revokeObjectURL(url);
    } catch { setErr('导出失败'); } finally { setBusy(false); }
  }

  return (
    <span className="inline-flex flex-col items-end">
      <button onClick={download} disabled={busy}
        className="rounded-lg border border-teal-300 bg-teal-50 px-3 py-1.5 text-xs font-medium text-teal-800 hover:bg-teal-100 disabled:opacity-50">
        {busy ? '导出中…' : '📦 导出剩余货物'}
      </button>
      {err && <span className="mt-1 text-[11px] text-red-600">{err}</span>}
    </span>
  );
}
