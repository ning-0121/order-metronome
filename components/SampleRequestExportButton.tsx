'use client';

/** 导出「打样申请单」Excel(按纸质样式,可打印发工厂)。挂在打样单详情。 */

import { useState } from 'react';
import { exportSampleRequest } from '@/app/actions/sample-request-export';

export function SampleRequestExportButton({ orderId }: { orderId: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function download() {
    setBusy(true); setErr('');
    try {
      const res = await exportSampleRequest(orderId);
      if (res.error || !res.base64) { setErr(res.error || '导出失败'); return; }
      const bytes = atob(res.base64);
      const arr = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
      const blob = new Blob([arr], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = res.fileName || '打样申请单.xlsx'; a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setErr(e?.message || '导出失败');
    } finally { setBusy(false); }
  }

  return (
    <span>
      <button onClick={download} disabled={busy}
        className="inline-flex items-center gap-1 rounded-lg border border-indigo-300 bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-50">
        {busy ? '导出中…' : '🖨️ 导出打样申请单'}
      </button>
      {err && <span className="ml-2 text-[11px] text-red-600">{err}</span>}
    </span>
  );
}
