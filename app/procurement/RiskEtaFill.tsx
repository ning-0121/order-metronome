'use client';

// 采购风险处置(2026-07-05 P2):在风险卡上填/改预计到货日。
// ≤需求日 → 下次物化自动消红;>需求日 → 如实显示预计晚到(不再"未定")。

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { setRiskLineEta } from '@/app/actions/procurement';

export function RiskEtaFill({ orderId, materialName, supplierId, requiredBy }: {
  orderId: string; materialName: string; supplierId?: string | null; requiredBy?: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [eta, setEta] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function submit() {
    if (!eta) { setMsg('请选择预计到货日'); return; }
    setBusy(true); setMsg('');
    const res = await setRiskLineEta({ orderId, materialName, supplierId: supplierId ?? null, newEta: eta });
    setBusy(false);
    if ((res as any).error) { setMsg((res as any).error); return; }
    const late = requiredBy && eta > requiredBy;
    setMsg(late
      ? `⚠ 已填(${(res as any).updated} 行),但晚于需求日 ${requiredBy} — 仍会预警,需催货或申请改期`
      : `✅ 已填预计到货日(${(res as any).updated} 行),不晚于需求日,风险将在下次刷新(≤15分钟)消除`);
    setOpen(false);
    router.refresh();
  }

  return (
    <div className="mt-1">
      {!open ? (
        <button onClick={() => setOpen(true)} className="text-[11px] px-2 py-0.5 rounded border border-indigo-200 text-indigo-600 hover:bg-indigo-50">
          📅 填预计到货日
        </button>
      ) : (
        <div className="flex items-center gap-1.5 flex-wrap">
          <input type="date" value={eta} onChange={e => setEta(e.target.value)} className="text-[11px] rounded border border-gray-300 px-1.5 py-0.5" />
          <button onClick={submit} disabled={busy} className="text-[11px] px-2 py-0.5 rounded bg-indigo-600 text-white disabled:opacity-50">{busy ? '…' : '保存'}</button>
          <button onClick={() => { setOpen(false); setMsg(''); }} className="text-[11px] text-gray-400">取消</button>
        </div>
      )}
      {msg && <p className="text-[11px] text-gray-600 mt-0.5">{msg}</p>}
    </div>
  );
}
