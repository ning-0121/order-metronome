'use client';

/**
 * 大货单耗核定(业务执行填,技术部大货版)—— 2026-07-06 用户拍板从采购挪到业务。
 * 业务在原辅料页逐款填大货单耗;采购侧「采购核料」只读带过来核实 + 填抛量。
 * 布料必填,否则采购不许归并。可上传技术部签名确认单。
 */

import { useEffect, useState } from 'react';
import { listBomConsumptionLines, saveBomProductionConsumption } from '@/app/actions/procurement-items';

export function BulkConsumptionEditor({ orderId, canEdit = true }: { orderId: string; canEdit?: boolean }) {
  const [lines, setLines] = useState<any[]>([]);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [open, setOpen] = useState<boolean | null>(null);

  async function load() {
    const r = await listBomConsumptionLines(orderId);
    if ((r as any).data) {
      setLines((r as any).data);
      setEdit(Object.fromEntries(((r as any).data as any[]).map((l) => [l.id, l.production_consumption != null ? String(l.production_consumption) : ''])));
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [orderId]);

  const missing = lines.filter((l) => l.required && !(Number(l.production_consumption) > 0));
  const effectiveOpen = open ?? missing.length > 0;   // 有缺 → 默认展开催填

  async function save() {
    setSaving(true); setMsg('');
    const entries = Object.fromEntries(Object.entries(edit).map(([id, v]) => [id, v === '' ? null : Number(v)]));
    const r = await saveBomProductionConsumption(orderId, entries as any);
    setSaving(false);
    if ((r as any).error) { setMsg((r as any).error); return; }
    setMsg(`✅ 大货单耗已保存(${(r as any).saved} 行)`);
    await load();
  }

  if (lines.length === 0) return null;

  return (
    <div className={`mb-4 rounded-xl border-2 p-3 space-y-2 ${missing.length > 0 ? 'border-amber-300 bg-amber-50/60' : 'border-gray-200 bg-white'}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-semibold text-gray-800">📐 大货单耗(业务填 · 技术部大货版)</span>
        {missing.length > 0
          ? <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">还差 {missing.length} 条布料未填 — 填完采购才能核料归并</span>
          : <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-medium">✅ 布料大货单耗已填齐</span>}
        {missing.length === 0 && (
          <button onClick={() => setOpen(!effectiveOpen)} className="text-xs px-2 py-1 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50">
            {effectiveOpen ? '收起 ▲' : `展开修改（${lines.length}）▼`}
          </button>
        )}
        {canEdit && effectiveOpen && (
          <button onClick={save} disabled={saving} className="ml-auto text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50">
            {saving ? '保存中…' : '💾 保存大货单耗'}
          </button>
        )}
      </div>
      {effectiveOpen && <>
        <p className="text-[11px] text-gray-500">按技术部大货版逐款填大货单耗(布料必填)。采购量 = Σ(件数 × 大货单耗) ×(1 + 采购抛量%)。旁边「报价单耗」来自报价基线,供你比对。请把技术部签名的确认单作为附件上传到订单文档区。</p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="text-left text-gray-400">
              {['款号', '颜色', '物料', '类型', '开发单耗', '报价单耗', '大货单耗(填)', '单位'].map((h) => (
                <th key={h} className="py-1.5 px-2 font-medium whitespace-nowrap">{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id} className={`border-t border-gray-100 ${l.required && !(Number(edit[l.id]) > 0) ? 'bg-amber-50' : ''}`}>
                  <td className="py-1.5 px-2 font-mono">{l.style_no || '—'}</td>
                  <td className="py-1.5 px-2">{l.color || '—'}</td>
                  <td className="py-1.5 px-2 text-gray-800">{l.material_name || '—'}</td>
                  <td className="py-1.5 px-2">{l.required ? <span className="text-amber-700 font-medium">布料·必填</span> : <span className="text-gray-400">辅料·可选</span>}</td>
                  <td className="py-1.5 px-2 text-gray-500">{l.development_consumption ?? '—'}</td>
                  <td className="py-1.5 px-2 text-indigo-600">{l.budget_consumption ?? '—'}</td>
                  <td className="py-1.5 px-2">
                    <input type="number" step="0.001" min="0" value={edit[l.id] ?? ''} disabled={!canEdit}
                      placeholder={l.required ? '必填' : `默认 ${l.development_consumption ?? '—'}`}
                      onChange={(e) => setEdit((p) => ({ ...p, [l.id]: e.target.value }))}
                      className={`w-24 rounded border px-2 py-1 disabled:bg-gray-50 ${l.required && !(Number(edit[l.id]) > 0) ? 'border-amber-400 bg-white' : 'border-gray-300'}`} />
                  </td>
                  <td className="py-1.5 px-2 text-gray-400">{l.unit || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {msg && <p className="text-xs text-gray-600">{msg}</p>}
      </>}
    </div>
  );
}
