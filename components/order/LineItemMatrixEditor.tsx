'use client';

/**
 * S1 富明细录入表 —— 逐款 款号/品名/图片/颜色/尺码×件数,实时汇总。
 * 手工录 or 编辑 AI 解析结果。存入 order_line_items,喂生产任务单 / 客户 PI。
 * 图片本轮支持填 URL;上传按钮随 S1.1(公开图片桶)补。
 */

import { useEffect, useState, useCallback } from 'react';
import { getOrderLineItems, saveOrderLineItems } from '@/app/actions/order-line-items';

type Color = { color_cn: string; color_en: string; sizes: Record<string, number>; qty?: number; remark?: string };
type Style = { style_no: string; product_name: string; image_url: string; colors: Color[] };

const DEFAULT_SIZES = ['XS', 'S', 'M', 'L', 'XL'];
const sumSizes = (s: Record<string, number>) => Object.values(s || {}).reduce((a, v) => a + (Number(v) || 0), 0);

export function LineItemMatrixEditor({ orderId, canEdit = true, value, onChange }: {
  orderId?: string; canEdit?: boolean; value?: Style[]; onChange?: (styles: Style[]) => void;
}) {
  // 受控模式(建单页:父组件持有明细,无 orderId,不自加载/自保存);否则详情模式(自加载 orderId + 保存按钮)
  const controlled = value !== undefined && !!onChange;
  const [sizeLabels, setSizeLabels] = useState<string[]>(DEFAULT_SIZES);
  const [internalStyles, setInternalStyles] = useState<Style[]>([]);
  const styles = controlled ? (value as Style[]) : internalStyles;
  const setStyles = (controlled ? onChange! : setInternalStyles) as (s: Style[]) => void;
  const [loading, setLoading] = useState(!controlled && !!orderId);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [newSize, setNewSize] = useState('');

  const load = useCallback(async () => {
    if (controlled || !orderId) { setLoading(false); return; }
    const res = await getOrderLineItems(orderId);
    if ((res as any).data) {
      const data = (res as any).data as Style[];
      setInternalStyles(data);
      // 尺码集 = 已有 sizes 键的并集(保序);空则默认
      const labels = new Set<string>();
      for (const st of data) for (const c of st.colors) for (const k of Object.keys(c.sizes || {})) labels.add(k);
      setSizeLabels(labels.size > 0 ? [...labels] : DEFAULT_SIZES);
    }
    setLoading(false);
  }, [orderId, controlled]);
  useEffect(() => { load(); }, [load]);

  // ── 尺码列 ──
  const addSize = () => { const s = newSize.trim(); if (s && !sizeLabels.includes(s)) setSizeLabels([...sizeLabels, s]); setNewSize(''); };
  const removeSize = (s: string) => {
    setSizeLabels(sizeLabels.filter((x) => x !== s));
    setStyles(styles.map((st) => ({ ...st, colors: st.colors.map((c) => { const { [s]: _, ...rest } = c.sizes; return { ...c, sizes: rest }; }) })));
  };

  // ── 款 ──
  const addStyle = () => setStyles([...styles, { style_no: '', product_name: '', image_url: '', colors: [{ color_cn: '', color_en: '', sizes: {} }] }]);
  const removeStyle = (i: number) => setStyles(styles.filter((_, x) => x !== i));
  const setStyleField = (i: number, k: keyof Style, v: string) => setStyles(styles.map((st, x) => x === i ? { ...st, [k]: v } : st));

  // ── 颜色 ──
  const addColor = (si: number) => setStyles(styles.map((st, x) => x === si ? { ...st, colors: [...st.colors, { color_cn: '', color_en: '', sizes: {} }] } : st));
  const removeColor = (si: number, ci: number) => setStyles(styles.map((st, x) => x === si ? { ...st, colors: st.colors.filter((_, y) => y !== ci) } : st));
  const setColorField = (si: number, ci: number, k: keyof Color, v: string) =>
    setStyles(styles.map((st, x) => x === si ? { ...st, colors: st.colors.map((c, y) => y === ci ? { ...c, [k]: v } : c) } : st));
  const setColorSize = (si: number, ci: number, size: string, v: string) =>
    setStyles(styles.map((st, x) => x === si ? { ...st, colors: st.colors.map((c, y) => y === ci ? { ...c, sizes: { ...c.sizes, [size]: Number(v) || 0 } } : c) } : st));

  // ── 汇总 ──
  const styleTotal = (st: Style) => st.colors.reduce((a, c) => a + sumSizes(c.sizes), 0);
  const orderTotal = styles.reduce((a, st) => a + styleTotal(st), 0);
  const colorRows = styles.reduce((a, st) => a + st.colors.length, 0);

  async function save() {
    if (!orderId) return;
    setSaving(true); setMsg('');
    const res = await saveOrderLineItems(orderId, styles);
    setSaving(false);
    if ((res as any).error) { setMsg('❌ ' + (res as any).error); return; }
    setMsg(`✅ 已保存 ${(res as any).styles} 款 / ${(res as any).lines} 行 / 共 ${(res as any).total} 件`);
    load();
  }

  if (loading) return <div className="text-sm text-gray-400 py-6">加载明细…</div>;

  const inp = 'rounded border border-gray-300 px-2 py-1 text-xs';
  return (
    <div className="space-y-3">
      {/* 顶部:尺码集 + 汇总 + 保存 */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-white rounded-xl border border-gray-200 p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-gray-500">尺码列:</span>
          {sizeLabels.map((s) => (
            <span key={s} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-gray-100 text-xs text-gray-700">
              {s}{canEdit && <button onClick={() => removeSize(s)} className="text-gray-400 hover:text-red-500">×</button>}
            </span>
          ))}
          {canEdit && (
            <span className="inline-flex items-center gap-1">
              <input value={newSize} onChange={(e) => setNewSize(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addSize()}
                placeholder="+码" className={`${inp} w-14`} />
              <button onClick={addSize} className="text-xs text-indigo-600">加</button>
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-600">总量 <b className="text-gray-900">{orderTotal}</b> 件 · <b>{styles.length}</b> 款 · <b>{colorRows}</b> 颜色行</span>
          {canEdit && !controlled && <button onClick={save} disabled={saving} className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700 disabled:opacity-50">{saving ? '保存中…' : '💾 保存明细'}</button>}
        </div>
      </div>
      {msg && <p className="text-xs text-gray-700">{msg}</p>}

      {styles.length === 0 && <div className="text-center py-8 text-sm text-gray-400 border-2 border-dashed border-gray-200 rounded-xl">暂无明细{canEdit ? ',点下面「+ 加款」开始录入' : ''}</div>}

      {/* 逐款 */}
      {styles.map((st, si) => (
        <div key={si} className="bg-white rounded-xl border border-gray-200 p-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <input value={st.style_no} onChange={(e) => setStyleField(si, 'style_no', e.target.value)} placeholder="款号 *" disabled={!canEdit} className={`${inp} w-28`} />
            <input value={st.product_name} onChange={(e) => setStyleField(si, 'product_name', e.target.value)} placeholder="品名" disabled={!canEdit} className={`${inp} w-40`} />
            <input value={st.image_url} onChange={(e) => setStyleField(si, 'image_url', e.target.value)} placeholder="产品图 URL(上传待 S1.1)" disabled={!canEdit} className={`${inp} flex-1 min-w-[160px]`} />
            {st.image_url && <a href={st.image_url} target="_blank" rel="noreferrer" className="text-xs text-indigo-600">看图</a>}
            <span className="text-xs text-gray-500">款小计 <b>{styleTotal(st)}</b></span>
            {canEdit && <button onClick={() => removeStyle(si)} className="text-xs text-red-500 hover:underline">删款</button>}
          </div>

          {/* 颜色 × 尺码 矩阵 */}
          <div className="overflow-x-auto">
            <table className="text-xs">
              <thead>
                <tr className="text-gray-400 text-left">
                  <th className="px-1 py-1 font-medium">颜色(中)</th>
                  <th className="px-1 py-1 font-medium">颜色(英)</th>
                  {sizeLabels.map((s) => <th key={s} className="px-1 py-1 font-medium text-center w-14">{s}</th>)}
                  <th className="px-1 py-1 font-medium text-center">小计</th>
                  {canEdit && <th></th>}
                </tr>
              </thead>
              <tbody>
                {st.colors.map((c, ci) => (
                  <tr key={ci} className="border-t border-gray-50">
                    <td className="px-1 py-1"><input value={c.color_cn} onChange={(e) => setColorField(si, ci, 'color_cn', e.target.value)} placeholder="白色" disabled={!canEdit} className={`${inp} w-20`} /></td>
                    <td className="px-1 py-1"><input value={c.color_en} onChange={(e) => setColorField(si, ci, 'color_en', e.target.value)} placeholder="WHT" disabled={!canEdit} className={`${inp} w-16`} /></td>
                    {sizeLabels.map((s) => (
                      <td key={s} className="px-1 py-1 text-center">
                        <input type="number" min="0" value={c.sizes[s] ?? ''} onChange={(e) => setColorSize(si, ci, s, e.target.value)} disabled={!canEdit} className={`${inp} w-14 text-center`} />
                      </td>
                    ))}
                    <td className="px-1 py-1 text-center font-mono font-semibold text-gray-900">{sumSizes(c.sizes)}</td>
                    {canEdit && <td className="px-1 py-1"><button onClick={() => removeColor(si, ci)} className="text-red-500">×</button></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {canEdit && <button onClick={() => addColor(si)} className="text-xs text-indigo-600 hover:underline">+ 加颜色</button>}
        </div>
      ))}

      {canEdit && <button onClick={addStyle} className="w-full py-2 rounded-xl border-2 border-dashed border-indigo-200 text-indigo-600 text-sm font-medium hover:bg-indigo-50">+ 加款</button>}
    </div>
  );
}
