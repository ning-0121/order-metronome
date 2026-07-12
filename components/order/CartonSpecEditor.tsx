'use client';

/**
 * 纸箱规格 + 箱唛(#3):一套默认 + 个别款/色例外 + 箱唛模板,系统按款×色实时派生。
 * 挂在「原辅料和包装」页。存 orders.carton_spec。
 */

import { useEffect, useMemo, useState } from 'react';
import { getCartonSpec, saveCartonSpec } from '@/app/actions/carton-spec';
import { deriveCartonRows, type CartonSpec, type CartonException } from '@/lib/domain/cartonSpec';

const emptyDefault = { box_type: '', dims_cm: { l: '', w: '', h: '' }, pcs_per_box: '', gross_kg: '', net_kg: '' };

export function CartonSpecEditor({ orderId }: { orderId: string }) {
  const [spec, setSpec] = useState<CartonSpec>({ default: { ...emptyDefault }, exceptions: [], mark_template: 'QIMO / PO:{PO} / {款号} / {颜色} / C/NO:{箱号}' });
  const [lines, setLines] = useState<any[]>([]);
  const [po, setPo] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    getCartonSpec(orderId).then((r) => {
      const d = (r as any).data;
      if (d) {
        if (d.spec) setSpec({ default: { ...emptyDefault, ...(d.spec.default || {}), dims_cm: { ...emptyDefault.dims_cm, ...(d.spec.default?.dims_cm || {}) } }, exceptions: d.spec.exceptions || [], mark_template: d.spec.mark_template ?? 'QIMO / PO:{PO} / {款号} / {颜色} / C/NO:{箱号}' });
        setLines(d.lines || []); setPo(d.po || '');
      }
      setLoading(false);
    });
  }, [orderId]);

  // 订单里出现过的款 / 色(例外下拉用)
  const styleOpts = useMemo(() => [...new Set(lines.map((l) => String(l.style_no || '').trim()).filter(Boolean))], [lines]);
  const colorOpts = useMemo(() => [...new Set(lines.map((l) => String(l.color_cn || l.color_en || '').trim()).filter(Boolean))], [lines]);
  const derived = useMemo(() => deriveCartonRows(spec, lines, { po }), [spec, lines, po]);

  const setDef = (k: string, v: any) => setSpec((s) => ({ ...s, default: { ...s.default, [k]: v } }));
  const setDim = (k: 'l' | 'w' | 'h', v: any) => setSpec((s) => ({ ...s, default: { ...s.default, dims_cm: { ...(s.default?.dims_cm || {}), [k]: v } } }));
  const addEx = () => setSpec((s) => ({ ...s, exceptions: [...(s.exceptions || []), { scope: 'style', style_no: styleOpts[0] || '', pcs_per_box: '' } as CartonException] }));
  const setEx = (i: number, patch: Partial<CartonException>) => setSpec((s) => ({ ...s, exceptions: (s.exceptions || []).map((e, x) => x === i ? { ...e, ...patch } : e) }));
  const rmEx = (i: number) => setSpec((s) => ({ ...s, exceptions: (s.exceptions || []).filter((_, x) => x !== i) }));

  async function save() {
    setSaving(true); setMsg('');
    // 清洗:数字字段转 number 或留空
    const num = (v: any) => v === '' || v == null ? undefined : (isNaN(Number(v)) ? undefined : Number(v));
    const cleanFields = (f: any) => ({ box_type: f.box_type?.trim() || undefined, dims_cm: (f.dims_cm && (f.dims_cm.l || f.dims_cm.w || f.dims_cm.h)) ? { l: num(f.dims_cm.l), w: num(f.dims_cm.w), h: num(f.dims_cm.h) } : undefined, pcs_per_box: num(f.pcs_per_box), gross_kg: num(f.gross_kg), net_kg: num(f.net_kg) });
    const payload: CartonSpec = {
      default: cleanFields(spec.default || {}),
      exceptions: (spec.exceptions || []).filter((e) => (e.scope === 'style' ? e.style_no : e.color)).map((e) => ({ scope: e.scope, ...(e.scope === 'style' ? { style_no: e.style_no } : { color: e.color }), ...cleanFields(e) })),
      mark_template: spec.mark_template?.trim() || undefined,
    };
    const r = await saveCartonSpec(orderId, payload);
    setSaving(false);
    setMsg((r as any).error ? '❌ ' + (r as any).error : '✅ 已保存');
  }

  if (loading) return null;
  const inp = 'rounded border border-gray-300 px-2 py-1 text-xs';

  return (
    <div className="mb-4 p-3 rounded-xl border border-orange-200 bg-orange-50/40">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 w-full text-left">
        <span className="text-sm font-semibold text-gray-800">📦 纸箱规格 + 箱唛</span>
        <span className="text-xs text-gray-500">一套默认 + 个别款/色例外,箱唛按款×色自动套(建单填,出货带走)</span>
        <span className="ml-auto text-xs text-orange-600">{open ? '收起' : '展开'}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          {/* 默认纸箱 */}
          <div>
            <p className="text-xs font-medium text-gray-600 mb-1">默认纸箱(整单共用)</p>
            <div className="flex flex-wrap items-center gap-2">
              <input placeholder="箱型(如 外箱)" value={spec.default?.box_type ?? ''} onChange={(e) => setDef('box_type', e.target.value)} className={`${inp} w-28`} />
              <span className="text-xs text-gray-400">尺寸cm</span>
              <input placeholder="长" value={spec.default?.dims_cm?.l ?? ''} onChange={(e) => setDim('l', e.target.value)} className={`${inp} w-14 text-center`} />
              <input placeholder="宽" value={spec.default?.dims_cm?.w ?? ''} onChange={(e) => setDim('w', e.target.value)} className={`${inp} w-14 text-center`} />
              <input placeholder="高" value={spec.default?.dims_cm?.h ?? ''} onChange={(e) => setDim('h', e.target.value)} className={`${inp} w-14 text-center`} />
              <input placeholder="每箱件数" type="number" value={spec.default?.pcs_per_box ?? ''} onChange={(e) => setDef('pcs_per_box', e.target.value)} className={`${inp} w-20 text-center`} />
              <input placeholder="毛重kg" type="number" value={spec.default?.gross_kg ?? ''} onChange={(e) => setDef('gross_kg', e.target.value)} className={`${inp} w-20 text-center`} />
              <input placeholder="净重kg" type="number" value={spec.default?.net_kg ?? ''} onChange={(e) => setDef('net_kg', e.target.value)} className={`${inp} w-20 text-center`} />
            </div>
          </div>

          {/* 例外 */}
          <div>
            <div className="flex items-center gap-2 mb-1">
              <p className="text-xs font-medium text-gray-600">例外(个别款/色大小不同,只填要改的)</p>
              <button onClick={addEx} className="text-xs text-orange-700 hover:underline">+ 加例外</button>
            </div>
            {(spec.exceptions || []).length === 0 ? <p className="text-[11px] text-gray-400">无例外 —— 所有款按默认。</p> : (
              <div className="space-y-1.5">
                {(spec.exceptions || []).map((e, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2 bg-white rounded-lg border border-orange-100 p-2">
                    <select value={e.scope} onChange={(ev) => setEx(i, { scope: ev.target.value as any })} className={`${inp} bg-white`}>
                      <option value="style">按款</option><option value="color">按色</option>
                    </select>
                    {e.scope === 'style'
                      ? <select value={e.style_no || ''} onChange={(ev) => setEx(i, { style_no: ev.target.value })} className={`${inp} bg-white w-32`}>{styleOpts.map((s) => <option key={s} value={s}>{s}</option>)}</select>
                      : <select value={e.color || ''} onChange={(ev) => setEx(i, { color: ev.target.value })} className={`${inp} bg-white w-28`}>{colorOpts.map((c) => <option key={c} value={c}>{c}</option>)}</select>}
                    <input placeholder="每箱件数" type="number" value={e.pcs_per_box ?? ''} onChange={(ev) => setEx(i, { pcs_per_box: ev.target.value })} className={`${inp} w-20 text-center`} />
                    <input placeholder="长" value={e.dims_cm?.l ?? ''} onChange={(ev) => setEx(i, { dims_cm: { ...(e.dims_cm || {}), l: ev.target.value } })} className={`${inp} w-12 text-center`} />
                    <input placeholder="宽" value={e.dims_cm?.w ?? ''} onChange={(ev) => setEx(i, { dims_cm: { ...(e.dims_cm || {}), w: ev.target.value } })} className={`${inp} w-12 text-center`} />
                    <input placeholder="高" value={e.dims_cm?.h ?? ''} onChange={(ev) => setEx(i, { dims_cm: { ...(e.dims_cm || {}), h: ev.target.value } })} className={`${inp} w-12 text-center`} />
                    <button onClick={() => rmEx(i)} className="text-gray-300 hover:text-rose-500 text-xs ml-auto">✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 箱唛模板 */}
          <div>
            <p className="text-xs font-medium text-gray-600 mb-1">箱唛模板 <span className="text-gray-400">(变量:{'{PO}'} {'{款号}'} {'{颜色}'} {'{箱号}'})</span></p>
            <input value={spec.mark_template ?? ''} onChange={(e) => setSpec((s) => ({ ...s, mark_template: e.target.value }))} className={`${inp} w-full`} />
          </div>

          {/* 派生预览 */}
          <div>
            <p className="text-xs font-medium text-gray-600 mb-1">📋 按款×色派生({derived.length} 行)</p>
            {derived.length === 0 ? <p className="text-[11px] text-gray-400">先在富录入表录款×色明细,这里自动派生每款纸箱/箱唛。</p> : (
              <div className="overflow-x-auto bg-white rounded-lg border border-orange-100">
                <table className="text-[11px] w-full">
                  <thead><tr className="text-gray-400 text-left border-b border-gray-100">
                    {['款号', '颜色', '件数', '箱型', '尺寸cm', '每箱', '箱数', '毛/净kg', '箱唛'].map((h) => <th key={h} className="px-2 py-1 whitespace-nowrap font-medium">{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {derived.map((r, i) => (
                      <tr key={i} className="border-b border-gray-50">
                        <td className="px-2 py-1 font-mono">{r.style_no || '—'}</td>
                        <td className="px-2 py-1">{r.color || '—'}</td>
                        <td className="px-2 py-1 text-right">{r.qty || '—'}</td>
                        <td className="px-2 py-1">{r.box_type || '—'}</td>
                        <td className="px-2 py-1">{r.dims || '—'}</td>
                        <td className="px-2 py-1 text-center">{r.pcs_per_box ?? '—'}</td>
                        <td className="px-2 py-1 text-center font-semibold">{r.box_count ?? '—'}</td>
                        <td className="px-2 py-1 text-center">{[r.gross_kg, r.net_kg].map((x) => x ?? '—').join('/')}</td>
                        <td className="px-2 py-1 text-gray-600">{r.mark || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button onClick={save} disabled={saving} className="px-4 py-1.5 rounded-lg bg-orange-600 text-white text-xs font-medium hover:bg-orange-700 disabled:opacity-50">{saving ? '保存中…' : '💾 保存纸箱规格'}</button>
            {msg && <span className="text-xs text-gray-700">{msg}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
