'use client';

import { useState } from 'react';
import { exportProductionTrackingSheet } from '@/app/actions/export-production-sheet';

export function ExportProductionSheetButton() {
  const [loading, setLoading] = useState(false);

  async function handleExport() {
    setLoading(true);
    try {
      const result = await exportProductionTrackingSheet();
      if (result.error) {
        alert(result.error);
        return;
      }
      if (!result.base64 || !result.fileName) {
        alert('导出失败：未返回文件内容');
        return;
      }
      // base64 → Blob → 下载
      const byteChars = atob(result.base64);
      const byteNums = new Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) byteNums[i] = byteChars.charCodeAt(i);
      const blob = new Blob([new Uint8Array(byteNums)], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = result.fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e: any) {
      alert('导出出错：' + (e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleExport}
      disabled={loading}
      className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 disabled:opacity-50 transition-all"
      title="导出所有进行中订单的生产跟单表"
    >
      <span>📥</span>
      {loading ? '导出中...' : '导出生产跟单表'}
    </button>
  );
}
