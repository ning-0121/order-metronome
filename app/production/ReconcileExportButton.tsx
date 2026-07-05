'use client';

/** 导出「滞留老单核对表」按钮:工厂期已过仍活跃的订单 → Excel(下拉列给采购/生产填)。 */

import { useState } from 'react';
import { exportProductionReconciliation } from '@/app/actions/production-center';

export function ReconcileExportButton() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function download() {
    setBusy(true); setErr('');
    try {
      const res = await exportProductionReconciliation();
      if (res.error || !res.base64) { setErr(res.error || '导出失败'); return; }
      const bytes = atob(res.base64);
      const arr = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
      const blob = new Blob([arr], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = res.fileName || '滞留老单核对表.xlsx';
      a.click();
      URL.revokeObjectURL(url);
    } finally { setBusy(false); }
  }

  return (
    <div className="text-right">
      <button onClick={download} disabled={busy}
        className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50">
        {busy ? '导出中…' : '📋 导出滞留老单核对表'}
      </button>
      {err && <p className="mt-1 text-[11px] text-red-600">{err}</p>}
    </div>
  );
}
