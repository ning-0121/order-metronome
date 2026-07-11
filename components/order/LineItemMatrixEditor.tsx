'use client';

/**
 * S1 富明细录入表 —— 逐款 款号/品名/图片/颜色/尺码×件数,实时汇总。
 * 手工录 or 编辑 AI 解析结果。存入 order_line_items,喂生产任务单 / 客户 PI。
 * 图片本轮支持填 URL;上传按钮随 S1.1(公开图片桶)补。
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { getOrderLineItems, saveOrderLineItems, parseOrderFile } from '@/app/actions/order-line-items';
import { parsePO } from '@/app/actions/po-parser';
import { listMaterialMaster } from '@/app/actions/material-master';
import { createClient as createBrowserClient } from '@/lib/supabase/client';
import { sortSizeKeys, orderSizeKeys } from '@/lib/utils/size-sort';

type Color = { color_cn: string; color_en: string; sizes: Record<string, number>; qty?: number; remark?: string; carton_count?: number | string };
// S1.2 每款布料(可多种)——名/门幅/单耗/单位/单价;单价=采购参考价(¥,只登记不自动进成本)
type Fabric = { material_id?: string | null; material_code?: string | null; name: string; width?: string; consumption?: string | number; unit?: string; price?: string | number };
type Style = {
  style_no: string; product_name: string; image_url: string; colors: Color[];
  product_name_en?: string;   // 款式英文描述(生产任务单/PI 双语)
  // 每款布料(自动同步成该款 BOM + 生产任务单用料)。fabrics 为准;fabric_* 存第一条做向后兼容。
  fabrics?: Fabric[];
  fabric_name?: string; fabric_width?: string; fabric_consumption?: string | number; fabric_unit?: string;
  set_multiplier?: number | string;   // 套装每套件数(1/空=非套装);算料按 件数×每套件数
  kit_set?: boolean;   // 异色套装:本款下各颜色=一套的组件(同码),客户按套计价;落库各色一行同 set_group_no,套价存主组件
  po_unit_price?: string | number;    // 客户 PO 成交单价(款级,给客户的价);仅 showPrice 时渲染,server 端按财务口径剥离
  purchase_unit_cost?: string | number;  // 经销/采购成品单逐款采购价(成本面,¥/件);仅 showPurchaseCost 时渲染
  source_po_number?: string;          // 多PO合单:本款来自哪张客户PO(只读溯源徽标;server 端解析成 source_order_po_id)
};

const emptyFabric = (): Fabric => ({ name: '', width: '', consumption: '', unit: 'kg', price: '', material_id: null, material_code: null });
// 展示用布料列表:优先 fabrics;缺则用旧 fabric_* 合成单条;都空给一条空行
const styleFabrics = (st: Style): Fabric[] => {
  if (Array.isArray(st.fabrics) && st.fabrics.length > 0) return st.fabrics;
  if (st.fabric_name || st.fabric_width || (st.fabric_consumption ?? '') !== '')
    return [{ name: st.fabric_name || '', width: st.fabric_width || '', consumption: st.fabric_consumption ?? '', unit: st.fabric_unit || 'kg', price: '', material_id: null }];
  return [emptyFabric()];
};

const DEFAULT_SIZES = ['XS', 'S', 'M', 'L', 'XL'];
const sumSizes = (s: Record<string, number>) => Object.values(s || {}).reduce((a, v) => a + (Number(v) || 0), 0);
// 并入新尺码到已有顺序末尾(保住业务手排的顺序不被打乱;新码之间按标准序)
const appendSizes = (prev: string[], incoming: Iterable<string>): string[] => {
  const seen = new Set(prev);
  const extra: string[] = [];
  for (const k of incoming) { if (k && !seen.has(k)) { seen.add(k); extra.push(k); } }
  return extra.length ? [...prev, ...sortSizeKeys(extra)] : prev;
};

export function LineItemMatrixEditor({ orderId, canEdit = true, value, onChange, showPrice = false, showPurchaseCost = false, hideFabrics = false, onParsed }: {
  orderId?: string; canEdit?: boolean; value?: Style[]; onChange?: (styles: Style[]) => void;
  showPrice?: boolean;   // 是否渲染客户 PO 成交价列(仅建单/售价可见场景传 true;生产任务单等不传)
  showPurchaseCost?: boolean;   // 是否渲染逐款采购价列(经销/采购成品单建单传 true)
  hideFabrics?: boolean;   // 隐藏每款布料/原辅料录入(经销/采购成品单 trade:买成品无原辅料)
  /** AI 解析成功时把完整解析结果(POParsedData:含交期/包装/质量要求/辅料/尺寸表)交给父组件——
   *  建单表单拿它随 createOrder 冻结进 orders.po_parse_snapshot(别处提取用);不传则忽略 */
  onParsed?: (data: any) => void;
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
  const [dragIdx, setDragIdx] = useState<number | null>(null);   // 尺码列拖拽排序
  const [uploading, setUploading] = useState<number | null>(null);
  const [parsing, setParsing] = useState(false);
  const [ratios, setRatios] = useState<Record<number, Record<string, number>>>({});   // 每款尺码配比(UI 助手,不入库)
  const [colorTotals, setColorTotals] = useState<Record<string, string>>({});          // 每色总量输入,key=`si-ci`

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
      // 尺码列并入(追加到末尾,保住已有手排顺序)
      const incoming: string[] = [...((res as any).sizeNames || [])];
      for (const ps of parsed) for (const c of ps.colors) for (const k of Object.keys(c.sizes || {})) incoming.push(k);
      setSizeLabels(prev => appendSizes(prev, incoming));
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
      // 详情模式带 orderId:解析成功后服务端把 AI 原文冻结到 orders.po_parse_snapshot(首冻,别处提取用)
      const res = await parsePO(fd, orderId);
      if (!res.ok || !res.data) { setMsg('❌ ' + (res.error || 'AI 解析失败')); setParsing(false); return; }
      onParsed?.(res.data);   // 建单(受控)模式:把完整解析结果交给父表单,随建单冻结
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
      const incoming: string[] = [];
      for (const ps of aiStyles) for (const c of ps.colors) for (const k of Object.keys(c.sizes || {})) incoming.push(k);
      setSizeLabels(prev => appendSizes(prev, incoming));
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
      // 尺码列 = 明细里出现过的码 ∪ 手排顺序里登记的码(含空列);
      // 有手排顺序(orders.size_order)按它排,未列出的码标准序附末尾;都无则默认
      const stored = ((res as any).sizeOrder as string[] | null) || null;
      const union = new Set<string>();
      for (const st of data) for (const c of st.colors) for (const k of Object.keys(c.sizes || {})) union.add(k);
      if (stored) for (const s of stored) if (s) union.add(s);
      setSizeLabels(union.size > 0 ? orderSizeKeys([...union], stored) : DEFAULT_SIZES);
    }
    setLoading(false);
  }, [orderId, controlled]);
  useEffect(() => { load(); }, [load]);

  // 受控模式(建单页):外部塞进来的明细(AI 解析/复制款)可能带新尺码 → 并入尺码列末尾(保住手排顺序)
  useEffect(() => {
    if (!controlled) return;
    setSizeLabels(prev => {
      const incoming: string[] = [];
      for (const st of (value || [])) for (const c of (st.colors || [])) for (const k of Object.keys(c.sizes || {})) incoming.push(k);
      return appendSizes(prev, incoming);
    });
  }, [controlled, value]);

  // ── 尺码列(顺序即业务手排真相;新增码追加到末尾,拖拽调整)──
  const addSize = () => { const s = newSize.trim(); if (s && !sizeLabels.includes(s)) setSizeLabels([...sizeLabels, s]); setNewSize(''); };
  const moveSize = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= sizeLabels.length || to >= sizeLabels.length) return;
    setSizeLabels(prev => { const a = [...prev]; const [m] = a.splice(from, 1); a.splice(to, 0, m); return a; });
  };
  const removeSize = (s: string) => {
    setSizeLabels(sizeLabels.filter((x) => x !== s));
    setStyles(styles.map((st) => ({ ...st, colors: st.colors.map((c) => { const { [s]: _, ...rest } = c.sizes; return { ...c, sizes: rest }; }) })));
  };

  // ── 款 ──
  const addStyle = () => setStyles([...styles, { style_no: '', product_name: '', image_url: '', fabrics: [emptyFabric()], fabric_name: '', fabric_width: '', fabric_consumption: '', fabric_unit: 'kg', po_unit_price: '', purchase_unit_cost: '', set_multiplier: 1, colors: [{ color_cn: '', color_en: '', sizes: {} }] }]);
  const removeStyle = (i: number) => setStyles(styles.filter((_, x) => x !== i));
  // 复制款:深拷贝(颜色/尺码件数/图片全带上),插在原款正下方,款号加「-副本」提示改;再改数量/图片即可
  const copyStyle = (i: number) => {
    const src = styles[i];
    const dup: Style = {
      style_no: src.style_no ? `${src.style_no}-副本` : '',
      product_name: src.product_name,
      image_url: src.image_url,
      fabrics: styleFabrics(src).map((f) => ({ ...f })),   // 多布料整组深拷贝
      fabric_name: src.fabric_name || '', fabric_width: src.fabric_width || '',
      fabric_consumption: src.fabric_consumption ?? '', fabric_unit: src.fabric_unit || 'kg', po_unit_price: src.po_unit_price ?? '', purchase_unit_cost: src.purchase_unit_cost ?? '',
      set_multiplier: src.set_multiplier ?? 1,
      kit_set: src.kit_set,   // 异色套装标记随复制款带上
      source_po_number: src.source_po_number,   // 多PO合单:复制款保留来源PO溯源
      colors: src.colors.map((c) => ({ ...c, sizes: { ...c.sizes } })),
    };
    setStyles([...styles.slice(0, i + 1), dup, ...styles.slice(i + 1)]);
  };
  const setStyleField = (i: number, k: keyof Style, v: string) => setStyles(styles.map((st, x) => x === i ? { ...st, [k]: v } : st));

  // ── 布料(每款可多种)──
  // 布料名搜物料库(category=fabric):防抖 250ms,只开一个下拉(key=si-fi)
  const [fabPick, setFabPick] = useState<{ key: string; results: any[]; loading: boolean } | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 写 fabrics 的同时把第一条镜像回旧 fabric_* 字段(老读者/建单只认单条时兜底)
  const withFabrics = (st: Style, fabrics: Fabric[]): Style => {
    const first = fabrics[0] || emptyFabric();
    return { ...st, fabrics,
      fabric_name: first.name || '', fabric_width: first.width || '',
      fabric_consumption: first.consumption ?? '', fabric_unit: first.unit || 'kg' };
  };
  const mapFabrics = (si: number, fn: (fabrics: Fabric[]) => Fabric[]) =>
    setStyles(styles.map((st, x) => x === si ? withFabrics(st, fn(styleFabrics(st))) : st));
  const addFabric = (si: number) => mapFabrics(si, (fs) => [...fs, emptyFabric()]);
  const removeFabric = (si: number, fi: number) => mapFabrics(si, (fs) => { const r = fs.filter((_, y) => y !== fi); return r.length ? r : [emptyFabric()]; });
  // 改名即视为脱离物料库绑定(手打新料);其余字段原样改
  const setFabricField = (si: number, fi: number, k: keyof Fabric, v: string) =>
    mapFabrics(si, (fs) => fs.map((f, y) => y === fi ? { ...f, [k]: v, ...(k === 'name' ? { material_id: null, material_code: null } : {}) } : f));
  // 选中物料库的料 → 带出 单价/单位/规格(门幅无独立列,用规格兜底)/单耗(仅当为空,不覆盖已填)
  const pickMaterial = (si: number, fi: number, m: any) => {
    mapFabrics(si, (fs) => fs.map((f, y) => y === fi ? {
      ...f,
      material_id: m.id || null,
      material_code: m.material_code || null,
      name: m.material_name || f.name,
      unit: m.default_unit || f.unit || 'kg',
      price: m.reference_price ?? f.price ?? '',
      width: f.width || m.specification || '',
      consumption: (f.consumption === '' || f.consumption == null) && m.default_consumption != null ? m.default_consumption : f.consumption,
    } : f));
    setFabPick(null);
  };

  const queryFabrics = (key: string, term: string) => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const q = term.trim();
    if (!q) { setFabPick(null); return; }
    setFabPick({ key, results: [], loading: true });
    searchTimer.current = setTimeout(async () => {
      const res = await listMaterialMaster({ search: q, category: 'fabric' });
      const results = ((res as any).data || []).slice(0, 8);
      setFabPick((prev) => (prev && prev.key === key ? { key, results, loading: false } : prev));
    }, 250);
  };

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

  // ── 尺码配比分摊(输入配比 + 每色总量 → 按比例摊到各码;向下取整后余数按小数从大到小 +1,总和精确=总量)──
  const setRatio = (si: number, size: string, v: string) =>
    setRatios((prev) => ({ ...prev, [si]: { ...(prev[si] || {}), [size]: Number(v) || 0 } }));
  function distributeByRatio(total: number, ratio: Record<string, number> | undefined, sizes: string[]): Record<string, number> {
    if (sizes.length === 0 || total <= 0) return {};
    let r = sizes.map((s) => Math.max(0, Number(ratio?.[s]) || 0));
    if (r.reduce((a, b) => a + b, 0) === 0) r = sizes.map(() => 1);   // 没填配比 → 平均分
    const sumR = r.reduce((a, b) => a + b, 0);
    const raw = r.map((x) => (total * x) / sumR);
    const floored = raw.map(Math.floor);
    const rem = total - floored.reduce((a, b) => a + b, 0);
    const byFrac = raw.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac);
    for (let k = 0; k < rem && byFrac.length; k++) floored[byFrac[k % byFrac.length].i]++;
    const out: Record<string, number> = {};
    sizes.forEach((s, i) => { out[s] = floored[i]; });
    return out;
  }
  const applyRatio = (si: number, ci: number) => {
    const total = Number(colorTotals[`${si}-${ci}`]) || 0;
    if (total <= 0) { setMsg('⚠ 先填该颜色的「总量」再点分摊'); return; }
    const dist = distributeByRatio(total, ratios[si], sizeLabels);
    setStyles(styles.map((st, x) => x === si ? { ...st, colors: st.colors.map((c, y) => y === ci ? { ...c, sizes: dist } : c) } : st));
  };
  const applyRatioAll = (si: number) =>
    setStyles(styles.map((st, x) => x !== si ? st : { ...st, colors: st.colors.map((c, ci) => {
      const total = Number(colorTotals[`${si}-${ci}`]) || 0;
      return total > 0 ? { ...c, sizes: distributeByRatio(total, ratios[si], sizeLabels) } : c;
    }) }));

  // ── 汇总 ──
  const styleTotal = (st: Style) => st.colors.reduce((a, c) => a + sumSizes(c.sizes), 0);
  const orderTotal = styles.reduce((a, st) => a + styleTotal(st), 0);
  const colorRows = styles.reduce((a, st) => a + st.colors.length, 0);

  async function save() {
    if (!orderId) return;
    setSaving(true); setMsg('');
    const res = await saveOrderLineItems(orderId, styles, sizeLabels);   // 尺码列手排顺序一并持久化
    setSaving(false);
    if ((res as any).error) { setMsg('❌ ' + (res as any).error); return; }
    setMsg(`✅ 已保存 ${(res as any).styles} 款 / ${(res as any).lines} 行 / 共 ${(res as any).total} 件`);
    load();
  }

  if (loading) return <div className="text-sm text-gray-400 py-6">加载明细…</div>;

  const inp = 'rounded border border-gray-300 px-2 py-1 text-xs';
  // 尺码/箱数数量格:够宽显全 4-6 位数 + 隐藏数字微调箭头(箭头会挤掉右侧数字导致「1160」显示成「116C」)
  const numCell = 'rounded border border-gray-300 px-1 py-1 text-xs text-center w-16 min-w-16 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none';
  return (
    <div className="space-y-3">
      {/* 顶部:尺码集 + 汇总 + 保存 */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-white rounded-xl border border-gray-200 p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-gray-500">尺码列{canEdit && <span className="text-gray-400">(可拖动排序)</span>}:</span>
          {sizeLabels.map((s, i) => (
            <span
              key={s}
              draggable={canEdit}
              onDragStart={() => setDragIdx(i)}
              onDragOver={(e) => { if (dragIdx !== null) e.preventDefault(); }}
              onDrop={(e) => { e.preventDefault(); if (dragIdx !== null) moveSize(dragIdx, i); setDragIdx(null); }}
              onDragEnd={() => setDragIdx(null)}
              title={canEdit ? '拖动调整尺码顺序(下游生产任务单/PI/采购/出货全按此序)' : undefined}
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded bg-gray-100 text-xs text-gray-700 ${canEdit ? 'cursor-grab active:cursor-grabbing' : ''} ${dragIdx === i ? 'opacity-40 ring-1 ring-indigo-300' : ''}`}
            >
              {canEdit && <span className="text-gray-300 select-none leading-none" aria-hidden>⋮⋮</span>}
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
            {st.source_po_number && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200 text-[11px] font-medium whitespace-nowrap" title="本款来自这张客户PO(多PO合单溯源)">
                📄 PO {st.source_po_number}
              </span>
            )}
            <input value={st.style_no} onChange={(e) => setStyleField(si, 'style_no', e.target.value)} placeholder="款号 *" disabled={!canEdit} className={`${inp} w-28`} />
            <input value={st.product_name} onChange={(e) => setStyleField(si, 'product_name', e.target.value)} placeholder="品名/款式描述(中)" disabled={!canEdit} className={`${inp} w-40`} />
            <input value={st.product_name_en || ''} onChange={(e) => setStyleField(si, 'product_name_en', e.target.value)} placeholder="款式描述(英) Style Desc" disabled={!canEdit} className={`${inp} w-44`} />
            <label className="inline-flex items-center gap-1 text-xs text-gray-500" title="套装每套几件(如两件套填2)。算料按 件数×每套件数;非套装留 1。">
              套装
              <input type="number" min="1" step="1" value={st.set_multiplier ?? ''} onChange={(e) => setStyleField(si, 'set_multiplier', e.target.value)}
                placeholder="1" disabled={!canEdit} className={`${inp} w-14`} />
              件/套
            </label>
            {/* 异色套装:各颜色=一套的组件(同码),客户按套计价 */}
            <label className="inline-flex items-center gap-1 text-xs text-amber-700" title="勾选=异色套装:本款下的各颜色是一套里的不同件(如一黑一藏青,同码)。客户按套计价,套价填一次;落库各色一行,生产/采购看分色件数。">
              <input type="checkbox" checked={!!st.kit_set} disabled={!canEdit}
                onChange={(e) => setStyleField(si, 'kit_set', e.target.checked as any)} />
              异色套装
            </label>
            {st.kit_set && canEdit && st.colors.length > 1 && (
              <button type="button" onClick={() => setStyles(styles.map((x, xi) => xi === si ? { ...x, colors: x.colors.map((c, ci) => ci === 0 ? c : { ...c, sizes: { ...x.colors[0].sizes } }) } : x))}
                className="text-[11px] text-amber-700 underline" title="把第一色的尺码配比复制到本款所有颜色(套装同码)">配比复制到各色</button>
            )}
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

          {/* 每款布料(S1.2,可多种):自动同步成该款 BOM + 生产任务单用料。trade(买成品)隐藏,无原辅料 */}
          <div className="space-y-1.5">
            {!hideFabrics && (<>
            {styleFabrics(st).map((fb, fi) => {
              const pkKey = `${si}-${fi}`;
              return (
                <div key={fi} className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-gray-400 w-14 shrink-0">{fi === 0 ? '🧵 布料' : ''}</span>
                  {/* 名称:可搜物料库,选中带出单价/单位/规格;也可手打新料 */}
                  <div className="relative">
                    <input value={fb.name || ''} disabled={!canEdit}
                      onChange={(e) => { setFabricField(si, fi, 'name', e.target.value); queryFabrics(pkKey, e.target.value); }}
                      onFocus={(e) => { if (e.target.value.trim()) queryFabrics(pkKey, e.target.value); }}
                      onBlur={() => setTimeout(() => setFabPick((p) => (p && p.key === pkKey ? null : p)), 150)}
                      placeholder="布料名(可搜物料库)" className={`${inp} w-44`} />
                    {fb.material_id && <span className="absolute -top-1.5 right-1 text-[9px] text-emerald-600" title="已关联物料库">●库</span>}
                    {canEdit && fabPick?.key === pkKey && (
                      <div className="absolute z-20 mt-1 w-64 max-h-60 overflow-auto rounded-lg border border-gray-200 bg-white shadow-lg text-xs">
                        {fabPick.loading && <div className="px-3 py-2 text-gray-400">搜索中…</div>}
                        {!fabPick.loading && fabPick.results.length === 0 && <div className="px-3 py-2 text-gray-400">物料库无匹配,直接手打即可</div>}
                        {fabPick.results.map((m: any) => (
                          <button key={m.id} type="button" onMouseDown={(e) => { e.preventDefault(); pickMaterial(si, fi, m); }}
                            className="block w-full text-left px-3 py-1.5 hover:bg-indigo-50 border-b border-gray-50 last:border-0">
                            <div className="font-medium text-gray-800">{m.material_name}{m.specification ? <span className="text-gray-400 font-normal"> · {m.specification}</span> : null}</div>
                            <div className="text-[11px] text-gray-500">{m.material_code || '无编码'} · {m.reference_price != null ? `¥${m.reference_price}/${m.default_unit || 'kg'}` : '无参考价'}</div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <input value={fb.width || ''} onChange={(e) => setFabricField(si, fi, 'width', e.target.value)} placeholder="门幅(如 150cm)" disabled={!canEdit} className={`${inp} w-24`} />
                  <input type="number" min="0" step="0.001" value={fb.consumption ?? ''} onChange={(e) => setFabricField(si, fi, 'consumption', e.target.value)} placeholder="单耗/件" disabled={!canEdit} className={`${inp} w-20 text-right`} />
                  <select value={fb.unit || 'kg'} onChange={(e) => setFabricField(si, fi, 'unit', e.target.value)} disabled={!canEdit} className={`${inp} bg-white`}>
                    {['kg', '米', '平方', '码'].map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                  <span className="inline-flex items-center gap-0.5 text-xs text-gray-400" title="采购参考单价(¥);选物料库自动带出,只登记不自动算成本">
                    ¥<input type="number" min="0" step="0.01" value={fb.price ?? ''} onChange={(e) => setFabricField(si, fi, 'price', e.target.value)} placeholder="单价" disabled={!canEdit} className={`${inp} w-20 text-right`} />
                  </span>
                  {canEdit && styleFabrics(st).length > 1 && <button onClick={() => removeFabric(si, fi)} className="text-red-500 text-sm" title="删这条布料">×</button>}
                </div>
              );
            })}
            {canEdit && <button onClick={() => addFabric(si)} className="ml-14 text-xs text-indigo-600 hover:underline">+ 加布料</button>}
            <p className="ml-14 text-[11px] text-gray-400">选物料库自动带出单价/单位(可改);录了会自动进该款 BOM 和生产任务单用料</p>
            </>)}
            {(showPrice || showPurchaseCost) && (
              <div className="flex flex-wrap items-center gap-3 ml-14">
                {showPrice && (
                  <span className="inline-flex items-center gap-2">
                    <span className="text-xs text-gray-400">💰 {st.kit_set ? '套价/套' : '客户报价/件'}</span>
                    <input type="number" min="0" step="0.01" value={st.po_unit_price ?? ''} onChange={(e) => setStyleField(si, 'po_unit_price', e.target.value)}
                      placeholder={st.kit_set ? '一套一口价' : '给客户价'} disabled={!canEdit} className={`${inp} w-24 text-right`} title={st.kit_set ? '异色套装:客户按套的一口价(一套=各色各一件);应收=套数×套价' : '客户成交单价(给客户的价,非我们报价);AI 解析预填,请核对后保存冻结'} />
                    {st.kit_set && <span className="text-[11px] text-amber-600">(按套)</span>}
                  </span>
                )}
                {showPurchaseCost && (
                  <span className="inline-flex items-center gap-2">
                    <span className="text-xs text-gray-400">🏭 采购价/件</span>
                    <input type="number" min="0" step="0.01" value={st.purchase_unit_cost ?? ''} onChange={(e) => setStyleField(si, 'purchase_unit_cost', e.target.value)}
                      placeholder="采购成本" disabled={!canEdit} className={`${inp} w-24 text-right`} title="我们采购该款的成本价(¥/件)" />
                    {canEdit && styles.length > 1 && (st.purchase_unit_cost ?? '') !== '' && (
                      <button type="button" onClick={() => setStyles(styles.map((x) => ({ ...x, purchase_unit_cost: st.purchase_unit_cost })))}
                        className="text-[11px] text-indigo-600 hover:underline" title="把此采购价套用到所有款(同价快填)">套用全部</button>
                    )}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* 尺码配比:填比例(如 1:2:2:1),每色填总量点「⚖」按此摊到各码 */}
          {canEdit && sizeLabels.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap mb-1.5 text-xs bg-amber-50/60 border border-amber-200 rounded-lg px-2 py-1.5">
              <span className="font-medium text-amber-800 whitespace-nowrap">⚖ 尺码配比</span>
              {sizeLabels.map((s) => (
                <label key={s} className="inline-flex items-center gap-1">
                  <span className="text-gray-500">{s}</span>
                  <input type="number" min="0" value={ratios[si]?.[s] ?? ''} onChange={(e) => setRatio(si, s, e.target.value)} placeholder="1"
                    className="w-11 rounded border border-amber-200 px-1 py-0.5 text-center" />
                </label>
              ))}
              <button onClick={() => applyRatioAll(si)} className="ml-auto text-[11px] px-2 py-1 rounded bg-amber-600 text-white font-medium hover:bg-amber-700 whitespace-nowrap">全部按总量分摊</button>
              <span className="w-full text-[11px] text-gray-400">填比例(如 S:M:L:XL=1:2:2:1);下面每色填「总量」→ 点行末「⚖」或右上「全部分摊」,按比例摊到各码,合计精确=总量。不填=平均分。</span>
            </div>
          )}

          {/* 颜色 × 尺码 矩阵 */}
          <div className="overflow-x-auto">
            <table className="text-xs">
              <thead>
                <tr className="text-gray-400 text-left">
                  <th className="px-1 py-1 font-medium">颜色(中)</th>
                  <th className="px-1 py-1 font-medium">颜色(英)</th>
                  {sizeLabels.map((s) => <th key={s} className="px-1 py-1 font-medium text-center w-16">{s}</th>)}
                  <th className="px-1 py-1 font-medium text-center">小计</th>
                  <th className="px-1 py-1 font-medium text-center">箱数</th>
                  {canEdit && <th className="px-1 py-1 font-medium text-center whitespace-nowrap text-amber-700">总量→分摊</th>}
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
                        <input type="number" min="0" value={c.sizes[s] ?? ''} onChange={(e) => setColorSize(si, ci, s, e.target.value)} disabled={!canEdit} className={numCell} />
                      </td>
                    ))}
                    <td className="px-1 py-1 text-center font-mono font-semibold text-gray-900">{sumSizes(c.sizes)}</td>
                    <td className="px-1 py-1 text-center">
                      <input type="number" min="0" value={c.carton_count ?? ''} onChange={(e) => setColorField(si, ci, 'carton_count', e.target.value)} placeholder="箱" disabled={!canEdit} className={numCell} />
                    </td>
                    {canEdit && (
                      <td className="px-1 py-1 text-center whitespace-nowrap">
                        <input type="number" min="0" value={colorTotals[`${si}-${ci}`] ?? ''} onChange={(e) => setColorTotals((p) => ({ ...p, [`${si}-${ci}`]: e.target.value }))} placeholder="总量" className={numCell} />
                        <button onClick={() => applyRatio(si, ci)} title="按上方配比把总量摊到各尺码" className="ml-1 text-amber-600 hover:text-amber-800 font-bold">⚖</button>
                      </td>
                    )}
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
