'use client';

import { useState } from 'react';
import { exportSampleRequest } from '@/app/actions/export-sample-request';

/**
 * 导出「打样申请单」按钮 — 仅样品单详情页渲染（由父组件按 order_type/order_purpose 控制是否挂载）
 * 下载机制：base64 → Blob → a.click()（同 ExportProductionSheetButton）
 */
export function ExportSampleRequestButton({ orderId }: { orderId: string }) {
  const [loading, setLoading] = useState(false);

  async function handleExport() {
    setLoading(true);
    try {
      const result = await exportSampleRequest(orderId);
      if (result.error) { alert(result.error); return; }
      if (!result.base64 || !result.fileName) { alert('导出失败：未返回文件内容'); return; }

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
      className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-violet-700 bg-violet-50 border border-violet-200 hover:bg-violet-100 disabled:opacity-50 transition-all"
      title="按打样申请单模板导出 Excel"
    >
      <span>📄</span>
      {loading ? '导出中...' : '导出打样申请单'}
    </button>
  );
}
