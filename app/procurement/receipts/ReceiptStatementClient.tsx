'use client';

import { useState, useMemo } from 'react';
import { exportGoodsReceiptStatement } from '@/app/actions/goods-receipt-export';

export function ReceiptStatementClient({
  suppliers, materials,
}: { suppliers: { id: string; name: string }[]; materials: string[] }) {
  const [supSel, setSupSel] = useState<Set<string>>(new Set());
  const [matSel, setMatSel] = useState<Set<string>>(new Set());
  const [matQ, setMatQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const shownMaterials = useMemo(() => {
    const q = matQ.trim().toLowerCase();
    return q ? materials.filter((m) => m.toLowerCase().includes(q)) : materials;
  }, [materials, matQ]);

  const toggle = (set: Set<string>, key: string, setter: (s: Set<string>) => void) => {
    const n = new Set(set); n.has(key) ? n.delete(key) : n.add(key); setter(n);
  };

  async function doExport() {
    setBusy(true); setMsg(null);
    const r = await exportGoodsReceiptStatement({
      supplierIds: supSel.size ? [...supSel] : undefined,
      materialNames: matSel.size ? [...matSel] : undefined,
    });
    setBusy(false);
    if (r.error || !r.data) { setMsg({ ok: false, text: r.error || '导出失败' }); return; }
    // base64 → 下载
    const bin = atob(r.data.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = r.data.filename; a.click();
    URL.revokeObjectURL(url);
    setMsg({ ok: true, text: `已导出 ${r.data.rowCount} 批收货 → ${r.data.filename}` });
  }

  const Chip = ({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) => (
    <button onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs ${on ? 'border-indigo-500 bg-indigo-50 text-indigo-700 font-medium' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}>
      {children}
    </button>
  );

  return (
    <div className="space-y-6">
      {/* 供应商 */}
      <div>
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-800">
          供应商 <span className="text-xs font-normal text-gray-400">({supSel.size ? `已选 ${supSel.size}` : '全部'})</span>
          {supSel.size > 0 && <button onClick={() => setSupSel(new Set())} className="text-xs font-normal text-indigo-600 hover:underline">清除</button>}
        </div>
        {suppliers.length === 0 ? <div className="text-xs text-gray-400">暂无收货记录</div> : (
          <div className="flex flex-wrap gap-2">
            {suppliers.map((s) => <Chip key={s.id} on={supSel.has(s.id)} onClick={() => toggle(supSel, s.id, setSupSel)}>{s.name}</Chip>)}
          </div>
        )}
      </div>

      {/* 物料名 */}
      <div>
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-800">
          物料名 <span className="text-xs font-normal text-gray-400">({matSel.size ? `已选 ${matSel.size}` : '全部'})</span>
          {matSel.size > 0 && <button onClick={() => setMatSel(new Set())} className="text-xs font-normal text-indigo-600 hover:underline">清除</button>}
        </div>
        {materials.length > 12 && (
          <input value={matQ} onChange={(e) => setMatQ(e.target.value)} placeholder="搜物料名…"
            className="mb-2 w-full rounded border border-gray-300 px-2 py-1 text-sm" />
        )}
        {materials.length === 0 ? <div className="text-xs text-gray-400">暂无物料</div> : (
          <div className="flex max-h-56 flex-wrap gap-2 overflow-y-auto">
            {shownMaterials.map((m) => <Chip key={m} on={matSel.has(m)} onClick={() => toggle(matSel, m, setMatSel)}>{m}</Chip>)}
          </div>
        )}
      </div>

      {/* 导出 */}
      <div className="flex items-center gap-3 border-t border-gray-100 pt-4">
        <button onClick={doExport} disabled={busy || suppliers.length === 0}
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
          {busy ? '导出中…' : '📥 导出收货对账单 Excel'}
        </button>
        <span className="text-xs text-gray-400">
          {supSel.size === 0 && matSel.size === 0 ? '未筛选=导出全部供应商' : `筛选:${supSel.size ? `${supSel.size} 供应商` : '全部供应商'}${matSel.size ? ` · ${matSel.size} 物料` : ''}`}
        </span>
      </div>
      {msg && <div className={`text-sm ${msg.ok ? 'text-emerald-700' : 'text-red-600'}`}>{msg.text}</div>}
    </div>
  );
}
