'use client';

/** 采购核料页的生产任务单下载(只下不改;复用 ManufacturingOrderTab 的下载模式) */

import { useState } from 'react';
import { generateManufacturingOrderSheet } from '@/app/actions/manufacturing-order';
import { base64ToBlob, triggerBlobDownload } from '@/lib/browser/download';

type DownloadResult = { error?: string; base64?: string; fileName?: string | null };

export function MoDownloadButton({ orderId, orderNo }: { orderId: string; orderNo?: string | null }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function download() {
    setBusy(true); setErr('');
    try {
      const res = await generateManufacturingOrderSheet(orderId) as DownloadResult;
      if (res.error || !res.base64) {
        setErr(res.error || '生成失败，请重试');
        return;
      }
      const blob = base64ToBlob(res.base64);
      triggerBlobDownload(blob, res.fileName || `生产任务单_${orderNo || orderId}.xlsx`);
      setErr('');
    } catch (error: unknown) {
      setErr(error instanceof Error ? error.message : '下载失败，请重试');
    } finally { setBusy(false); }
  }

  return (
    <div className="text-right">
      <button type="button" onClick={download} disabled={busy} aria-busy={busy}
        className="px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50">
        {busy ? '生成中…' : '📋 下载生产任务单'}
      </button>
      {err && <p className="text-xs text-red-600 mt-1">{err}</p>}
    </div>
  );
}
