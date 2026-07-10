'use client';

// 采购流水导出(2026-07-09 用户:银行流水式,选时间段导出"在哪家供应商下过什么面辅料",月度对账)。
import { useState } from 'react';
import { exportProcurementLedger } from '@/app/actions/purchase-orders';

// 默认:本月 1 号 → 今天
function monthRange() {
  const now = new Date();
  const y = now.getFullYear(); const m = now.getMonth();
  const p = (n: number) => String(n).padStart(2, '0');
  const from = `${y}-${p(m + 1)}-01`;
  const to = `${y}-${p(m + 1)}-${p(now.getDate())}`;
  return { from, to };
}

export function ProcurementLedgerExport() {
  const def = monthRange();
  const [from, setFrom] = useState(def.from);
  const [to, setTo] = useState(def.to);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function run() {
    setBusy(true); setMsg('');
    const r = await exportProcurementLedger({ dateFrom: from || null, dateTo: to || null });
    setBusy(false);
    if ((r as any).error || !r.base64) { setMsg('❌ ' + ((r as any).error || '导出失败')); return; }
    const bin = atob(r.base64); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const blob = new Blob([arr], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = r.fileName || '采购流水.xlsx'; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    setMsg(`✅ 已导出 ${r.count} 条 · 合计 RMB ${(r.total ?? 0).toLocaleString()}`);
  }

  const inp = 'rounded border border-gray-300 px-2 py-1 text-sm';
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2 flex-wrap justify-end">
        <span className="text-xs text-gray-500">对账区间</span>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inp} />
        <span className="text-gray-400 text-xs">→</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inp} />
        <button onClick={run} disabled={busy}
          className="text-sm px-3 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 font-medium disabled:opacity-50">
          {busy ? '导出中…' : '📥 导出采购流水'}
        </button>
      </div>
      {msg && <span className={`text-xs ${msg.startsWith('✅') ? 'text-emerald-600' : 'text-rose-600'}`}>{msg}</span>}
    </div>
  );
}
