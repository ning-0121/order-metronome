'use client';

/**
 * S1 富明细录入表 —— 逐款 款号/品名/图片/颜色/尺码×件数,实时汇总。
 * 手工录 or 编辑 AI 解析结果。存入 order_line_items,喂生产任务单 / 客户 PI。
 * 图片本轮支持填 URL;上传按钮随 S1.1(公开图片桶)补。
 */

import { useEffect, useState, useCallback } from 'react';
import { getOrderLineItems, saveOrderLineItems, parseOrderFile } from '@/app/actions/order-line-items';
import { parsePO } from '@/app/actions/po-parser';
import { createClient as createBrowserClient } from '@/lib/supabase/client';
import { sortSizeKeys } from '@/lib/utils/size-sort';

type Color = { color_cn: string; color_en: string; sizes: Record<string, number>; qty?: number; remark?: string; carton_count?: number | string };
type Style = {
  style_no: string; product_name: string; image_url: string; colors: Color[];
  product_name_en?: string;   // 款式英文描述(生产任务单/PI 双语)
  // S1.2 每款布料(自动同步成该款 BOM 第一行 + 生产任务单用料)
  fabric_name?: string; fabric_width?: string; fabric_consumption?: string | number; fabric_unit?: string;
  set_multiplier?: number | string;   // 套装每套件数(1/空=非套装);算料按 件数×每套件数
  po_unit_price?: string | number;    // 客户 PO 成交单价(款级,给客户的价);仅 showPrice 时渲染,server 端按财务口径剥离
};

const DEFAULT_SIZES = ['XS', 'S', 'M', 'L', 'XL'];
const sumSizes = (s: Record<string, number>) => Object.values(s || {}).reduce((a, v) => a + (Number(v) || 0), 0);

export function LineItemMatrixEditor({ orderId, canEdit = true, value, onChange, showPrice = false }: {
  orderId?: string; canEdit?: boolean; value?: Style[]; onChange?: (styles: Style[]) => void;
  showPrice?: boolean;   // 是否渲染客户 PO 成交价列(仅建单/售价可见场景传 true;生产任务单等不传)
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
  const [uploading, setUploading] = useState<number | null>(null);
  const [parsing, setParsing] = useState(false);

  // 步骤2b:上传客户订单 Excel → 零 token 解析 → 归组追加进富录入表(预览可改,再保存)
  async function handleParseOrderFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';   // 允许重复选同一文件
    if (!file) return;
    setParsing(true); setMsg('');
    try {
      const buf = await file.arrayBuffer();
      let bin = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      const base64 = btoa(bin);
      const res = await parseOrderFile(base64);
      if ((res as any).error) { setMsg('❌ ' + (res as any).error); setParsing(false); return; }
      const parsed = ((res as any).styles || []) as Style[];
      if (parsed.length === 0) { setMsg('❌ 没解析到任何款'); setParsing(false); return; }
      // 追加合并:同款号(非空)并入其颜色行,否则新增款
      const merged: Style[] = styles.map((s) => ({ ...s, colors: [...s.colors] }));
      for (const ps of parsed) {
        const key = (ps.style_no || '').trim();
        const hit = key ? merged.find((m) => (m.style_no || '').trim() === key) : null;
        if (hit) hit.colors.push(...ps.colors);
        else merged.push(ps);
      }
      setStyles(merged);
      // 尺码列并集
      const labelSet = new Set(sizeLabels);
      for (const s of ((res as any).sizeNames || [])) labelSet.add(s);
      for (const ps of parsed) for (const c of ps.colors) for (const k of Object.keys(c.sizes || {})) labelSet.add(k);
      setSizeLabels(sortSizeKeys([...labelSet]));
      const nColors = parsed.reduce((a, s) => a + s.colors.length, 0);
      setMsg(`✅ 已解析 ${parsed.length} 款 / ${nColors} 颜色行,请核对数量后${controlled ? '提交建单' : '点「💾 保存明细」'}`);
    } catch (err: any) {
      setMsg('❌ 读取失败:' + (err?.message || String(err)));
    }
    setParsing(false);
  }

  // 步骤2c:复杂版式/尺码配比(如「S:M:L=2:2:2」+每色总量,零token代码解析读不出)→ 走 AI 解析。
  // AI 已把配比按比例摊成每码件数(sizes 是件数不是比例);解析→并入富录入表→人核对→保存冻结。
  async function handleParseAI(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setParsing(true); setMsg('🤖 AI 正在读取配比/复杂版式…(约 10-20 秒)');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await parsePO(fd);
      if (!res.ok || !res.data) { setMsg('❌ ' + (res.error || 'AI 解析失败')); setParsing(false); return; }
      const isImg = /\.(png|jpe?g)$/i.test(file.name);
      const notes = (res.data.confidence_notes || []).filter(Boolean).join('；');
      const aiStyles: Style[] = (res.data.styles || []).map((s: any) => ({
        style_no: s.style_no || '', product_name: s.product_name || '', product_name_en: '', image_url: '',
        fabric_name: s.material || '', fabric_width: '', fabric_consumption: '', fabric_unit: 'kg', po_unit_price: '', set_multiplier: 1,
        colors: (s.colors || []).map((c: any) => ({
          color_cn: c.color_cn || '', color_en: c.color_en || '', sizes: c.sizes || {}, qty: c.qty || 0, remark: c.packaging || '',
        })),
      }));
      if (aiStyles.length === 0) {
        // 复杂版式(合并单元格/图片/配比散在备注)Excel 转文本常读不全 → 引导截图当图片传(vision 更稳)
        setMsg(`❌ AI 没解析到款${notes ? `（AI:${notes}）` : ''}。${isImg ? '这张图 AI 也没读到,请换更清晰/更完整的截图。' : '年年旺这类复杂版式建议:把这张表截图(含款号/颜色数量/配比 S:M:L)当图片传给「🤖 AI 解析配比」,vision 比 Excel 转文本准得多。'}`);
        setParsing(false); return;
      }
      // 提示 sizes 是否空(配比没摊出来)
      const noSizeStyles = aiStyles.filter((s) => s.colors.every((c) => !c.sizes || Object.keys(c.sizes).length === 0)).length;
      // 并入(同 code parse:同款号合并颜色行,否则新增款)
      const merged: Style[] = styles.map((s) => ({ ...s, colors: [...s.colors] }));
      for (const ps of aiStyles) {
        const key = (ps.style_no || '').trim();
        const hit = key ? merged.find((m) => (m.style_no || '').trim() === key) : null;
        if (hit) hit.colors.push(...ps.colors); else merged.push(ps);
      }
      setStyles(merged);
      const labelSet = new Set(sizeLabels);
      for (const ps of aiStyles) for (const c of ps.colors) for (const k of Object.keys(c.sizes || {})) labelSet.add(k);
      setSizeLabels(sortSizeKeys([...labelSet]));
      const nColors = aiStyles.reduce((a, s) => a + s.colors.length, 0);
      const sizeWarn = noSizeStyles > 0 ? ` ⚠ 有 ${noSizeStyles} 款没摊出尺码(配比没读到),请手动补尺码或截图当图片重传` : '';
      setMsg(`✅ AI 解析 ${aiStyles.length} 款 / ${nColors} 颜色行(配比已按比例摊成每码件数),请核对数量后${controlled ? '提交建单' : '点「💾 保存明细」'}${sizeWarn}`);
    } catch (err: any) {
      setMsg('❌ AI 解析失败:' + (err?.message || String(err)));
    }
    setParsing(false);
  }

  const load = useCallback(async () => {
    if (controlled || !orderId) { setLoading(false); return; }
    const res = await getOrderLineItems(orderId);
    if ((res as any).data) {
      const data = (res as any).data as Style[];
      setInternalStyles(data);
      // 尺码集 = 已有 sizes 键的并集,按标准序 XS→S→M→L→XL→…;空则默认
      const labels = new Set<string>();
      for (const st of data) for (const c of st.colors) for (const k of Object.keys(c.sizes || {})) labels.add(k);
      setSizeLabels(labels.size > 0 ? sortSizeKeys([...labels]) : DEFAULT_SIZES);
    }
    setLoading(false);
  }, [orderId, controlled]);
  useEffect(() => { load(); }, [load]);

  // 受控模式(建单页):外部塞进来的明细(AI 解析/复制款)可能带新尺码 → 并入尺码列并保持标准序
  useEffect(() => {
    if (!controlled) return;
    setSizeLabels(prev => {
      const set = new Set(prev);
      let changed = false;
      for (const st of (value || [])) for (const c of (st.colors || [])) for (const k of Object.keys(c.sizes || {})) {
        if (!set.has(k)) { set.add(k); changed = true; }
      }
      return changed ? sortSizeKeys([...set]) : prev;
    });
  }, [controlled, value]);

  // ── 尺码列 ──
  const addSize = () => { const s = newSize.trim(); if (s && !sizeLabels.includes(s)) setSizeLabels(sortSizeKeys([...sizeLabels, s])); setNewSize(''); };
  const removeSize = (s: string) => {
    setSizeLabels(sizeLabels.filter((x) => x !== s));
    setStyles(styles.map((st) => ({ ...st, colors: st.colors.map((c) => { const { [s]: _, ...rest } = c.sizes; return { ...c, sizes: rest }; }) })));
  };

  // ── 款 ──
  const addStyle = () => setStyles([...styles, { style_no: '', product_name: '', image_url: '', fabric_name: '', fabric_width: '', fabric_consumption: '', fabric_unit: 'kg', po_unit_price: '', set_multiplier: 1, colors: [{ color_cn: '', color_en: '', sizes: {} }] }]);
  const removeStyle = (i: number) => setStyles(styles.filter((_, x) => x !== i));
  // 复制款:深拷贝(颜色/尺码件数/图片全带上),插在原款正下方,款号加「-副本」提示改;再改数量/图片即可
  const copyStyle = (i: number) => {
    const src = styles[i];
    const dup: Style = {
      style_no: src.style_no ? `${src.style_no}-副本` : '',
      product_name: src.product_name,
      image_url: src.image_url,
      fabric_name: src.fabric_name || '', fabric_width: src.fabric_width || '',
      fabric_consumption: src.fabric_consumption ?? '', fabric_unit: src.fabric_unit || 'kg', po_unit_price: src.po_unit_price ?? '',
      set_multiplier: src.set_multiplier ?? 1,
      colors: src.colors.map((c) => ({ ...c, sizes: { ...c.sizes } })),
    };
    setStyles([...styles.slice(0, i + 1), dup, ...styles.slice(i + 1)]);
  };
  const setStyleField = (i: number, k: keyof Style, v: string) => setStyles(styles.map((st, x) => x === i ? { ...st, [k]: v } : st));

  // S1.1 上传产品图 → 公开桶 product-images → 存 publicUrl 进 image_url
  async function uploadImage(si: number, file: File) {
    setUploading(si);
    try {
      const supabase = createBrowserClient();
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
      const path = `styles/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const { error } = await supabase.storage.from('product-images').upload(path, file, { contentType: file.type, upsert: false });
      if (error) { alert('上传失败:' + error.message + '(请确认已建 product-images 公开桶)'); return; }
      const { data } = supabase.storage.from('product-images').getPublicUrl(path);
      setStyleField(si, 'image_url', data.publicUrl);
    } finally { setUploading(null); }
  }

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
          {canEdit && (
            <label className={`px-3 py-1.5 rounded-lg border border-indigo-200 text-indigo-600 text-xs font-medium hover:bg-indigo-50 cursor-pointer ${parsing ? 'opacity-50 pointer-events-none' : ''}`} title="尺码数量成列的客户订单/生产单 Excel(如伊彤数量表),零 token 解析,预览可改">
              {parsing ? '解析中…' : '📄 上传客户订单'}
              <input type="file" accept=".xlsx,.xls" className="hidden" onChange={handleParseOrderFile} disabled={parsing} />
            </label>
          )}
          {canEdit && (
            <label className={`px-3 py-1.5 rounded-lg border border-purple-200 text-purple-600 text-xs font-medium hover:bg-purple-50 cursor-pointer ${parsing ? 'opacity-50 pointer-events-none' : ''}`} title="复杂版式/尺码配比(如年年旺:S:M:L=2:2:2 + 每色总量,或图片/PDF)用 AI 读取,自动按配比摊成每码件数">
              {parsing ? 'AI 解析中…' : '🤖 AI 解析配比'}
              <input type="file" accept=".xlsx,.xls,.pdf,.png,.jpg,.jpeg" className="hidden" onChange={handleParseAI} disabled={parsing} />
            </label>
          )}
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
            <input value={st.product_name} onChange={(e) => setStyleField(si, 'product_name', e.target.value)} placeholder="品名/款式描述(中)" disabled={!canEdit} className={`${inp} w-40`} />
            <input value={st.product_name_en || ''} onChange={(e) => setStyleField(si, 'product_name_en', e.target.value)} placeholder="款式描述(英) Style Desc" disabled={!canEdit} className={`${inp} w-44`} />
            <label className="inline-flex items-center gap-1 text-xs text-gray-500" title="套装每套几件(如两件套填2)。算料按 件数×每套件数;非套装留 1。">
              套装
              <input type="number" min="1" step="1" value={st.set_multiplier ?? ''} onChange={(e) => setStyleField(si, 'set_multiplier', e.target.value)}
                placeholder="1" disabled={!canEdit} className={`${inp} w-14`} />
              件/套
            </label>
            <input value={st.image_url} onChange={(e) => setStyleField(si, 'image_url', e.target.value)} placeholder="产品图 URL 或点上传" disabled={!canEdit} className={`${inp} flex-1 min-w-[140px]`} />
            {canEdit && (
              <label className="text-xs px-2 py-1 rounded bg-indigo-50 text-indigo-700 border border-indigo-200 cursor-pointer hover:bg-indigo-100 whitespace-nowrap">
                {uploading === si ? '上传中…' : '📷 上传'}
                <input type="file" accept="image/*" className="hidden" disabled={uploading !== null}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadImage(si, f); e.currentTarget.value = ''; }} />
              </label>
            )}
            {st.image_url && <a href={st.image_url} target="_blank" rel="noreferrer" className="text-xs text-indigo-600">看图</a>}
            <span className="text-xs text-gray-500">款小计 <b>{styleTotal(st)}</b></span>
            {canEdit && <button onClick={() => copyStyle(si)} className="text-xs text-indigo-600 hover:underline">复制款</button>}
            {canEdit && <button onClick={() => removeStyle(si)} className="text-xs text-red-500 hover:underline">删款</button>}
          </div>

          {/* 每款布料(S1.2):自动同步成该款 BOM 第一行 + 生产任务单用料单耗 */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-gray-400 w-14 shrink-0">🧵 布料</span>
            <input value={st.fabric_name || ''} onChange={(e) => setStyleField(si, 'fabric_name', e.target.value)} placeholder="布料名(如 280g 仿锦)" disabled={!canEdit} className={`${inp} w-44`} />
            <input value={st.fabric_width || ''} onChange={(e) => setStyleField(si, 'fabric_width', e.target.value)} placeholder="门幅(如 150cm)" disabled={!canEdit} className={`${inp} w-28`} />
            <input type="number" min="0" step="0.001" value={st.fabric_consumption ?? ''} onChange={(e) => setStyleField(si, 'fabric_consumption', e.target.value)} placeholder="单耗/件" disabled={!canEdit} className={`${inp} w-20 text-right`} />
            <select value={st.fabric_unit || 'kg'} onChange={(e) => setStyleField(si, 'fabric_unit', e.target.value)} disabled={!canEdit} className={`${inp} bg-white`}>
              {['kg', '米', '平方', '码'].map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
            <span className="text-[11px] text-gray-400">录了会自动进该款 BOM 和生产任务单用料</span>
            {showPrice && (
              <>
                <span className="text-xs text-gray-400 ml-2">💰 PO单价</span>
                <input type="number" min="0" step="0.01" value={st.po_unit_price ?? ''} onChange={(e) => setStyleField(si, 'po_unit_price', e.target.value)}
                  placeholder="给客户价/件" disabled={!canEdit} className={`${inp} w-24 text-right`} title="客户 PO 成交单价(给客户的价,非我们报价);AI 解析预填,请核对后保存冻结" />
              </>
            )}
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
                  <th className="px-1 py-1 font-medium text-center">箱数</th>
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
                    <td className="px-1 py-1 text-center">
                      <input type="number" min="0" value={c.carton_count ?? ''} onChange={(e) => setColorField(si, ci, 'carton_count', e.target.value)} placeholder="箱" disabled={!canEdit} className={`${inp} w-14 text-center`} />
                    </td>
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
