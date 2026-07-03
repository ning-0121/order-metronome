'use client';

/** 采购核料页的生产任务单下载(只下不改;复用 ManufacturingOrderTab 的下载模式) */

import { useState } from 'react';
import { generateManufacturingOrderSheet } from '@/app/actions/manufacturing-order';

export function MoDownloadButton({ orderId, orderNo }: { orderId: string; orderNo?: string | null }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function download() {
    setBusy(true); setErr('');
    try {
      const res = await generateManufacturingOrderSheet(orderId);
      if (res.error || !res.base64) { setErr(res.error || '生成失败'); return; }
      const bytes = atob(res.base64);
      const arr = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
      const blob = new Blob([arr], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = res.fileName || `生产任务单_${orderNo || orderId}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } finally { setBusy(false); }
  }

  return (
    <div className="text-right">
      <button onClick={download} disabled={busy}
        className="px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50">
        {busy ? '生成中…' : '📋 下载生产任务单'}
      </button>
      {err && <p className="text-xs text-red-600 mt-1">{err}</p>}
    </div>
  );
}
