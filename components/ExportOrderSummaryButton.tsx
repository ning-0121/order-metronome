'use client';

/**
 * 「导出订单汇总(周报)」按钮 —— 业务一键把自己名下订单导成汇总 Excel,没数据的列手填。
 */

import { useState } from 'react';
import { exportMyOrderSummary } from '@/app/actions/export-order-summary';

export function ExportOrderSummaryButton({ className = '' }: { className?: string }) {
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');

  async function handleExport() {
    setLoading(true); setMsg('');
    try {
      const res = await exportMyOrderSummary();
      if ((res as any).error) { setMsg((res as any).error); setLoading(false); return; }
      const { base64, fileName } = res as any;
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = fileName || '订单汇总.xlsx';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      setMsg(`✅ 已导出 ${(res as any).count} 行`);
    } catch (e: any) {
      setMsg('导出失败:' + (e?.message || String(e)));
    }
    setLoading(false);
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button onClick={handleExport} disabled={loading}
        className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white text-gray-700 border border-gray-200 text-sm font-medium hover:bg-gray-50 disabled:opacity-50 ${className}`}
        title="把你名下订单导成周报汇总 Excel(客户/款名/颜色/交期等自动带出,面料类型/加工方法等没数据的自己补)">
        {loading ? '导出中…' : '📊 导出订单汇总'}
      </button>
      {msg && <span className="text-xs text-gray-500">{msg}</span>}
    </span>
  );
}
