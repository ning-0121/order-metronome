'use client';

/**
 * 物料供应链详情抽屉(SC-P1):多供应商 / 单位换算 / 替代物料 / 库存策略。
 * 写权限由 canManage 控制(action 层再把关一次)。读=登录即可。
 */

import { useEffect, useState, useCallback } from 'react';
import { listSuppliers } from '@/app/actions/suppliers';
import {
  listMaterialSuppliers, upsertMaterialSupplier, deleteMaterialSupplier,
  listMaterialUom, upsertMaterialUom, deleteMaterialUom, convertMaterialUnit,
  listMaterialAlternatives, upsertMaterialAlternative, deleteMaterialAlternative,
  getMaterialStockPolicy, setMaterialStockPolicy, listMaterialMaster,
} from '@/app/actions/material-master';

const REL_LABEL: Record<string, string> = { equivalent: '等效', substitute: '替代', upgrade: '升级' };
const inp = 'rounded-lg border border-gray-300 px-2 py-1.5 text-xs';

export function MaterialDetailPanel({ material, canManage, onClose }: {
  material: { id: string; material_name: string; material_code?: string | null };
  canManage: boolean; onClose: () => void;
}) {
  const mid = material.id;
  const [tab, setTab] = useState<'supplier' | 'uom' | 'alt' | 'stock'>('supplier');
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [sups, setSups] = useState<any[]>([]);
  const [uoms, setUoms] = useState<any[]>([]);
  const [alts, setAlts] = useState<any[]>([]);
  const [stock, setStock] = useState<any>({ safety_stock_qty: '', reorder_point: '', max_stock: '' });
  const [msg, setMsg] = useState('');

  const reload = useCallback(async () => {
    const [s, u, a, st] = await Promise.all([
      listMaterialSuppliers(mid), listMaterialUom(mid), listMaterialAlternatives(mid), getMaterialStockPolicy(mid),
    ]);
    if ((s as any).data) setSups((s as any).data);
    if ((u as any).data) setUoms((u as any).data);
    if ((a as any).data) setAlts((a as any).data);
    const sd = (st as any).data || {};
    setStock({ safety_stock_qty: sd.safety_stock_qty ?? '', reorder_point: sd.reorder_point ?? '', max_stock: sd.max_stock ?? '' });
  }, [mid]);

  useEffect(() => { listSuppliers().then((r) => setSuppliers(r.data || [])); }, []);
  useEffect(() => { reload(); }, [reload]);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 2500); };
  async function run(p: Promise<any>, ok: string) {
    const r = await p;
    if (r?.error) { flash('❌ ' + r.error); return false; }
    flash('✅ ' + ok); await reload(); return true;
  }

  // 各段表单态
  const [sf, setSf] = useState<any>({ supplierId: '', unit_price: '', lead_days: '', moq: '', purchase_unit: '', is_preferred: false });
  const [uf, setUf] = useState<any>({ from_unit: '', to_unit: '', factor: '' });
  const [af, setAf] = useState<any>({ altMaterialMasterId: '', relation: 'substitute', ratio: '1' });
  const [altSearch, setAltSearch] = useState('');
  const [altOpts, setAltOpts] = useState<any[]>([]);
  const [conv, setConv] = useState<any>({ qty: '', from: '', to: '', out: '' });

  useEffect(() => {
    if (altSearch.trim().length < 2) { setAltOpts([]); return; }
    const t = setTimeout(async () => {
      const r = await listMaterialMaster({ search: altSearch });
      setAltOpts(((r as any).data || []).filter((m: any) => m.id !== mid).slice(0, 8));
    }, 300);
    return () => clearTimeout(t);
  }, [altSearch, mid]);

  async function doConvert() {
    const r = await convertMaterialUnit(mid, Number(conv.qty), conv.from, conv.to);
    setConv((c: any) => ({ ...c, out: (r as any).hasPath ? String((r as any).data) : '无换算路径' }));
  }

  const TABS: [string, string][] = [['supplier', `供应商 (${sups.length})`], ['uom', `换算 (${uoms.length})`], ['alt', `替代 (${alts.length})`], ['stock', '库存策略']];

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white w-full max-w-xl h-full overflow-y-auto shadow-xl p-5">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">{material.material_name}</h2>
            <p className="text-xs text-gray-400 font-mono">{material.material_code || '—'} · 供应链详情</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-sm">✕ 关闭</button>
        </div>
        {msg && <div className="mb-2 text-xs text-gray-700">{msg}</div>}
        {!canManage && <div className="mb-2 text-[11px] text-amber-600">只读:仅理单/采购/管理员可维护</div>}

        <div className="flex gap-1 border-b border-gray-200 mb-3">
          {TABS.map(([k, l]) => (
            <button key={k} onClick={() => setTab(k as any)}
              className={`px-3 py-1.5 text-xs font-medium border-b-2 -mb-px ${tab === k ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-gray-500 hover:text-gray-800'}`}>{l}</button>
          ))}
        </div>

        {/* 供应商 */}
        {tab === 'supplier' && (
          <div className="space-y-3">
            {sups.length === 0 ? <p className="text-xs text-gray-400">暂无供应商</p> : (
              <table className="w-full text-xs">
                <thead><tr className="text-left text-gray-400">{['供应商', '底价', '交期', 'MOQ', '单位', '首选', ''].map(h => <th key={h} className="py-1 pr-2 font-medium">{h}</th>)}</tr></thead>
                <tbody>{sups.map((r) => (
                  <tr key={r.id} className="border-t border-gray-100">
                    <td className="py-1 pr-2 text-gray-800">{r.supplier_name || '—'}</td>
                    <td className="py-1 pr-2 font-mono">{r.unit_price ?? '—'}</td>
                    <td className="py-1 pr-2">{r.lead_days ?? '—'}</td>
                    <td className="py-1 pr-2">{r.moq ?? '—'}</td>
                    <td className="py-1 pr-2">{r.purchase_unit || '—'}</td>
                    <td className="py-1 pr-2">{r.is_preferred ? '⭐' : ''}</td>
                    <td className="py-1">{canManage && <button onClick={() => run(deleteMaterialSupplier(r.id), '已删')} className="text-red-500 hover:underline">删</button>}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
            {canManage && (
              <div className="rounded-lg bg-gray-50 p-3 flex flex-wrap items-end gap-2">
                <select value={sf.supplierId} onChange={e => setSf({ ...sf, supplierId: e.target.value })} className={`${inp} bg-white`}>
                  <option value="">— 供应商 —</option>
                  {suppliers.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <input value={sf.unit_price} onChange={e => setSf({ ...sf, unit_price: e.target.value })} placeholder="底价" type="number" className={`${inp} w-20`} />
                <input value={sf.lead_days} onChange={e => setSf({ ...sf, lead_days: e.target.value })} placeholder="交期" type="number" className={`${inp} w-16`} />
                <input value={sf.moq} onChange={e => setSf({ ...sf, moq: e.target.value })} placeholder="MOQ" type="number" className={`${inp} w-16`} />
                <input value={sf.purchase_unit} onChange={e => setSf({ ...sf, purchase_unit: e.target.value })} placeholder="单位" className={`${inp} w-16`} />
                <label className="flex items-center gap-1 text-xs text-gray-600"><input type="checkbox" checked={sf.is_preferred} onChange={e => setSf({ ...sf, is_preferred: e.target.checked })} />首选</label>
                <button onClick={async () => { if (!sf.supplierId) return flash('❌ 请选供应商'); if (await run(upsertMaterialSupplier({ materialMasterId: mid, ...sf }), '已保存')) setSf({ supplierId: '', unit_price: '', lead_days: '', moq: '', purchase_unit: '', is_preferred: false }); }}
                  className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs">加供应商</button>
              </div>
            )}
          </div>
        )}

        {/* 单位换算 */}
        {tab === 'uom' && (
          <div className="space-y-3">
            {uoms.length === 0 ? <p className="text-xs text-gray-400">暂无换算</p> : (
              <ul className="text-xs space-y-1">{uoms.map((r) => (
                <li key={r.id} className="flex items-center justify-between border-b border-gray-100 py-1">
                  <span className="text-gray-700 font-mono">1 {r.from_unit} = {r.factor} {r.to_unit}</span>
                  {canManage && <button onClick={() => run(deleteMaterialUom(r.id), '已删')} className="text-red-500 hover:underline">删</button>}
                </li>
              ))}</ul>
            )}
            {canManage && (
              <div className="rounded-lg bg-gray-50 p-3 flex flex-wrap items-end gap-2">
                <span className="text-xs text-gray-500">1</span>
                <input value={uf.from_unit} onChange={e => setUf({ ...uf, from_unit: e.target.value })} placeholder="源单位" className={`${inp} w-20`} />
                <span className="text-xs text-gray-500">=</span>
                <input value={uf.factor} onChange={e => setUf({ ...uf, factor: e.target.value })} placeholder="系数" type="number" step="any" className={`${inp} w-24`} />
                <input value={uf.to_unit} onChange={e => setUf({ ...uf, to_unit: e.target.value })} placeholder="目标单位" className={`${inp} w-20`} />
                <button onClick={async () => { if (await run(upsertMaterialUom({ materialMasterId: mid, ...uf }), '已保存')) setUf({ from_unit: '', to_unit: '', factor: '' }); }}
                  className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs">加换算</button>
              </div>
            )}
            <div className="rounded-lg border border-gray-200 p-3 flex flex-wrap items-end gap-2">
              <span className="text-xs text-gray-500">试算:</span>
              <input value={conv.qty} onChange={e => setConv({ ...conv, qty: e.target.value })} placeholder="数量" type="number" className={`${inp} w-20`} />
              <input value={conv.from} onChange={e => setConv({ ...conv, from: e.target.value })} placeholder="从" className={`${inp} w-16`} />
              <span className="text-xs text-gray-500">→</span>
              <input value={conv.to} onChange={e => setConv({ ...conv, to: e.target.value })} placeholder="到" className={`${inp} w-16`} />
              <button onClick={doConvert} className="px-3 py-1.5 rounded-lg border border-gray-300 text-xs">算</button>
              {conv.out !== '' && <span className="text-xs font-mono text-indigo-700">= {conv.out}</span>}
            </div>
          </div>
        )}

        {/* 替代物料 */}
        {tab === 'alt' && (
          <div className="space-y-3">
            {alts.length === 0 ? <p className="text-xs text-gray-400">暂无替代</p> : (
              <ul className="text-xs space-y-1">{alts.map((r) => (
                <li key={r.id} className="flex items-center justify-between border-b border-gray-100 py-1">
                  <span className="text-gray-700">{r.alt_material_name || r.alt_material_master_id} <span className="text-gray-400">({REL_LABEL[r.relation] || r.relation} · 比 {r.ratio})</span></span>
                  {canManage && <button onClick={() => run(deleteMaterialAlternative(r.id), '已删')} className="text-red-500 hover:underline">删</button>}
                </li>
              ))}</ul>
            )}
            {canManage && (
              <div className="rounded-lg bg-gray-50 p-3 space-y-2">
                <input value={altSearch} onChange={e => setAltSearch(e.target.value)} placeholder="搜替代物料(名/编码,≥2字)" className={`${inp} w-full`} />
                {altOpts.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {altOpts.map((m: any) => (
                      <button key={m.id} onClick={() => { setAf({ ...af, altMaterialMasterId: m.id }); setAltSearch(m.material_name); setAltOpts([]); }}
                        className={`px-2 py-1 rounded border text-xs ${af.altMaterialMasterId === m.id ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-gray-200 text-gray-600'}`}>{m.material_name}</button>
                    ))}
                  </div>
                )}
                <div className="flex flex-wrap items-end gap-2">
                  <select value={af.relation} onChange={e => setAf({ ...af, relation: e.target.value })} className={`${inp} bg-white`}>
                    <option value="substitute">替代</option><option value="equivalent">等效</option><option value="upgrade">升级</option>
                  </select>
                  <input value={af.ratio} onChange={e => setAf({ ...af, ratio: e.target.value })} placeholder="用量比" type="number" step="any" className={`${inp} w-20`} />
                  <button onClick={async () => { if (!af.altMaterialMasterId) return flash('❌ 请选替代物料'); if (await run(upsertMaterialAlternative({ materialMasterId: mid, ...af }), '已保存')) { setAf({ altMaterialMasterId: '', relation: 'substitute', ratio: '1' }); setAltSearch(''); } }}
                    className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs">加替代</button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* 库存策略 */}
        {tab === 'stock' && (
          <div className="space-y-3">
            <p className="text-xs text-gray-400">物料级库存策略(P3 补货引擎读:available &lt; 再订货点 → 补到最高库存)。</p>
            <div className="grid grid-cols-3 gap-2">
              {([['safety_stock_qty', '安全库存'], ['reorder_point', '再订货点'], ['max_stock', '最高库存']] as const).map(([k, l]) => (
                <label key={k} className="text-xs text-gray-600">{l}
                  <input type="number" step="any" disabled={!canManage} value={stock[k]} onChange={e => setStock({ ...stock, [k]: e.target.value })}
                    className={`mt-1 w-full ${inp} disabled:bg-gray-50`} />
                </label>
              ))}
            </div>
            {canManage && (
              <button onClick={() => run(setMaterialStockPolicy(mid, stock), '已保存库存策略')}
                className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-xs font-medium">保存策略</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
