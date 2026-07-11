'use client';
import { useEffect, useState } from 'react';
import { getBomItems, addBomItem, addBomItemsBatch, updateBomItem, deleteBomItem, getTrimLibraryBrands, importFromTrimLibrary, submitBomToProcurement, setBomSampleGiven, addBomItemFromMaster, addTemporaryBomItem, listCopyableOrders, copyBomFromOrder, instantiateOrderMaterialPackage } from '@/app/actions/bom';
import { BulkConsumptionEditor } from '@/components/BulkConsumptionEditor';
import { listMaterialMaster } from '@/app/actions/material-master';
import { getQuoteBaseline } from '@/app/actions/quote-baseline';
import { uploadSizeChart, listSizeCharts, deleteSizeChart } from '@/app/actions/size-chart';
import { generateTrimSheet } from '@/app/actions/manufacturing-order';
import { matchBaseline, checkOverBaseline, type BaselineLine } from '@/lib/domain/cost-baseline';

// 10 值 material_type 中文 label(含 master 的 print/washing/embroidery/service)
const CAT_LABEL: Record<string, string> = {
  fabric: '面料', trim: '辅料', lining: '里料', label: '标签', packing: '包装',
  print: '印花', washing: '水洗', embroidery: '绣花', service: '服务', other: '其他',
};
// 临时物料/主数据可选的 8 类别(不含 BOM 专用的 lining/label)
const MASTER_CATS = ['fabric', 'trim', 'packing', 'print', 'washing', 'embroidery', 'service', 'other'];
const emptyTempForm = { material_name: '', category: 'fabric', default_unit: '', specification: '', default_supplier_name: '', qty_per_piece: '', color: '', placement: '', notes: '', special_requirements: '' };

const emptyForm = { material_name: '', material_type: 'fabric', material_code: '', placement: '', color: '', qty_per_piece: '', total_qty: '', unit: 'meter', supplier: '', spec: '', notes: '', special_requirements: '', override_reason: '', style_no: '', pack_size: '', image_urls: [] as string[], attachment_files: [] as Array<{ name: string; url: string }> };

// 带入弹窗用的「通用」哨兵值（区别于具体品牌字符串）
const GENERIC = '__generic__';

export function BomTab({ orderId }: { orderId: string }) {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // 提交采购 / 样品
  const [submitting, setSubmitting] = useState(false);
  const [submitMsg, setSubmitMsg] = useState('');

  // 从客户标准库带入
  const [showImport, setShowImport] = useState(false);
  const [brandData, setBrandData] = useState<{ customerName: string; brands: string[]; hasGeneric: boolean; total: number } | null>(null);
  const [brandLoading, setBrandLoading] = useState(false);
  const [selectedBrand, setSelectedBrand] = useState<string>('');
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState('');
  const [importErr, setImportErr] = useState('');

  // 从物料主数据选择（O1b 结构化录入主路径）
  const [showMaster, setShowMaster] = useState(false);
  const [masterSearch, setMasterSearch] = useState('');
  const [masterResults, setMasterResults] = useState<any[]>([]);
  const [masterLoading, setMasterLoading] = useState(false);
  const [picked, setPicked] = useState<any | null>(null);
  const [poForm, setPoForm] = useState({ qty_per_piece: '', color: '', placement: '', notes: '', special_requirements: '' });
  const [masterSaving, setMasterSaving] = useState(false);
  const [masterErr, setMasterErr] = useState('');

  // 订单内创建临时物料（O1b-2）
  const [creatingTemp, setCreatingTemp] = useState(false);
  const [tempForm, setTempForm] = useState(emptyTempForm);
  const [tempSaving, setTempSaving] = useState(false);
  const [tempErr, setTempErr] = useState('');

  // 复制上一单原辅料（O1b-3）
  const [showCopy, setShowCopy] = useState(false);
  const [copySearch, setCopySearch] = useState('');
  const [copyOrders, setCopyOrders] = useState<any[]>([]);
  const [copyLoading, setCopyLoading] = useState(false);
  const [copySource, setCopySource] = useState<any | null>(null);
  const [copyPreview, setCopyPreview] = useState<any[]>([]);
  const [copyMode, setCopyMode] = useState<'append' | 'replace'>('append');
  const [copySaving, setCopySaving] = useState(false);
  const [copyErr, setCopyErr] = useState('');

  // Product Phase 2A:从产品款实例化 + 编辑模板行 Override
  const [instantiating, setInstantiating] = useState(false);
  const [instMsg, setInstMsg] = useState('');
  const [editingTemplate, setEditingTemplate] = useState(false);  // 正在编辑的行是否来自产品款模板

  // 色卡/辅料图上传(公开桶 product-images/materials/,URL 追加进 materials_bom.image_urls)
  const [imgUploadingId, setImgUploadingId] = useState<string | null>(null);
  async function uploadBomImage(item: any, file: File) {
    setImgUploadingId(item.id);
    try {
      const { createClient: createBrowserClient } = await import('@/lib/supabase/client');
      const supabase = createBrowserClient();
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
      const path = `materials/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const { error: upErr } = await supabase.storage.from('product-images').upload(path, file, { contentType: file.type });
      if (upErr) { alert('上传失败:' + upErr.message); return; }
      const { data } = supabase.storage.from('product-images').getPublicUrl(path);
      const next = [...(Array.isArray(item.image_urls) ? item.image_urls : []), data.publicUrl];
      const res = await updateBomItem(item.id, orderId, { image_urls: next });
      if ((res as any).error) { alert('保存失败:' + (res as any).error); return; }
      await reload();
    } finally { setImgUploadingId(null); }
  }

  // 排版稿/文件附件上传(分款吊卡/箱唛等;公开桶 product-images/materials/attach/,追加进 attachment_files)
  const [attUploadingId, setAttUploadingId] = useState<string | null>(null);
  async function uploadBomAttachment(item: any, file: File) {
    if (file.size > 50 * 1024 * 1024) { alert('文件超过 50MB'); return; }
    setAttUploadingId(item.id);
    try {
      const { createClient: createBrowserClient } = await import('@/lib/supabase/client');
      const supabase = createBrowserClient();
      const ext = (file.name.split('.').pop() || 'bin').toLowerCase();
      const path = `materials/attach/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const { error: upErr } = await supabase.storage.from('product-images').upload(path, file, { contentType: file.type });
      if (upErr) { alert('上传失败:' + upErr.message); return; }
      const { data } = supabase.storage.from('product-images').getPublicUrl(path);
      const next = [...(Array.isArray(item.attachment_files) ? item.attachment_files : []), { name: file.name, url: data.publicUrl }].slice(0, 12);
      const res = await updateBomItem(item.id, orderId, { attachment_files: next });
      if ((res as any).error) { alert('保存失败:' + (res as any).error); return; }
      await reload();
    } finally { setAttUploadingId(null); }
  }

  // 录料表单内直接传图(新增/编辑都可):slot 0→辅料单「示例画稿」列, slot 1→「位置说明及示意图」列。
  // 按位置写进 form.image_urls[slot],保存时随行入库;生成辅料单直接读该位置,不用再单独去列表贴图。
  const [formImgUploading, setFormImgUploading] = useState<0 | 1 | null>(null);
  async function uploadFormImage(slot: 0 | 1, file: File) {
    setFormImgUploading(slot);
    try {
      const { createClient: createBrowserClient } = await import('@/lib/supabase/client');
      const supabase = createBrowserClient();
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
      const path = `materials/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const { error: upErr } = await supabase.storage.from('product-images').upload(path, file, { contentType: file.type });
      if (upErr) { alert('上传失败:' + upErr.message); return; }
      const { data } = supabase.storage.from('product-images').getPublicUrl(path);
      setForm(f => { const arr = [...(f.image_urls || [])]; arr[slot] = data.publicUrl; return { ...f, image_urls: arr }; });
    } finally { setFormImgUploading(null); }
  }
  const removeFormImage = (slot: 0 | 1) =>
    setForm(f => { const arr = [...(f.image_urls || [])]; arr[slot] = ''; return { ...f, image_urls: arr }; });

  // 录料表单内直接传【文件附件】(排版稿/分款吊卡/箱唛等,PDF/AI/CDR/xlsx…):随行入库 attachment_files。
  const [formAttUploading, setFormAttUploading] = useState(false);
  async function uploadFormAttachment(file: File) {
    if (file.size > 50 * 1024 * 1024) { alert('文件超过 50MB'); return; }
    setFormAttUploading(true);
    try {
      const { createClient: createBrowserClient } = await import('@/lib/supabase/client');
      const supabase = createBrowserClient();
      const ext = (file.name.split('.').pop() || 'bin').toLowerCase();
      const path = `materials/attach/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const { error: upErr } = await supabase.storage.from('product-images').upload(path, file, { contentType: file.type });
      if (upErr) { alert('上传失败:' + upErr.message); return; }
      const { data } = supabase.storage.from('product-images').getPublicUrl(path);
      setForm(f => ({ ...f, attachment_files: [...(f.attachment_files || []), { name: file.name, url: data.publicUrl }].slice(0, 12) }));
    } finally { setFormAttUploading(false); }
  }
  const removeFormAttachment = (url: string) =>
    setForm(f => ({ ...f, attachment_files: (f.attachment_files || []).filter((a) => a.url !== url) }));

  // 原辅料单批量识别(上传文件 → AI 读行 → 检查修改 → 批量入库)
  const [parsing, setParsing] = useState(false);
  const [parseRows, setParseRows] = useState<any[] | null>(null);
  const [parseNotes, setParseNotes] = useState<string[]>([]);
  const [parseFileName, setParseFileName] = useState('');
  const [parseErr, setParseErr] = useState('');
  const [batchSaving, setBatchSaving] = useState(false);

  const reload = () => getBomItems(orderId).then(({ data }) => setItems(data || []));
  useEffect(() => { reload().then(() => setLoading(false)); }, [orderId]);

  // 报价基线(P2:BOM 单耗超报价单耗 → 提示)
  const [baseLines, setBaseLines] = useState<BaselineLine[]>([]);
  useEffect(() => { getQuoteBaseline(orderId).then((r) => setBaseLines(((r as any).data?.lines || []) as BaselineLine[])).catch(() => {}); }, [orderId]);
  const overBaseline = (it: any) => {
    if (!baseLines.length) return null;
    const base = matchBaseline(baseLines, it.material_name, it.color, it.style_no);
    if (!base.matched) return null;
    const chk = checkOverBaseline(base, it.qty_per_piece != null ? Number(it.qty_per_piece) : null, null);
    return chk.over_consumption ? chk : null;
  };

  // ── 原辅料单批量识别 ──
  async function handleParseFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setParsing(true); setParseErr(''); setParseRows(null);
    try {
      const { parseBomFile } = await import('@/app/actions/bom-parser');
      const fd = new FormData();
      fd.append('file', file);
      const res = await parseBomFile(fd);
      if (!res.ok || !res.data) { setParseErr(res.error || '解析失败'); return; }
      setParseRows(res.data.items.map(i => ({ ...i })));
      setParseNotes(res.data.confidence_notes || []);
      setParseFileName(file.name);
    } catch (err: any) {
      setParseErr(err?.message || '解析异常');
    } finally { setParsing(false); }
  }
  const setParseField = (i: number, k: string, v: string) =>
    setParseRows(rows => (rows || []).map((r, x) => x === i ? { ...r, [k]: v } : r));
  const removeParseRow = (i: number) => setParseRows(rows => (rows || []).filter((_, x) => x !== i));

  async function confirmBatchInsert() {
    if (!parseRows || parseRows.length === 0) return;
    setBatchSaving(true); setParseErr('');
    const res = await addBomItemsBatch(orderId, parseRows.map(r => ({
      ...r, qty_per_piece: r.qty_per_piece === '' || r.qty_per_piece == null ? null : Number(r.qty_per_piece),
    })));
    setBatchSaving(false);
    if (res.error) { setParseErr(res.error); return; }
    setParseRows(null); setParseNotes([]); setParseFileName('');
    await reload();
  }

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  async function handleSave() {
    setSaving(true); setError('');
    const payload = {
      material_name: form.material_name, material_type: form.material_type,
      material_code: form.material_code || undefined,
      placement: form.placement || undefined, color: form.color || undefined,
      qty_per_piece: form.qty_per_piece ? parseFloat(form.qty_per_piece) : undefined,
      total_qty: form.total_qty ? parseFloat(form.total_qty) : undefined,
      unit: form.unit, supplier: form.supplier || undefined, spec: form.spec || undefined,
      notes: form.notes || undefined, special_requirements: form.special_requirements || undefined,
      style_no: form.style_no?.trim() || undefined,
      pack_size: form.pack_size ? parseFloat(form.pack_size) : undefined,   // 每包件数(打包辅料;需求÷每包件数)
      image_urls: (form.image_urls || []).map(u => u || ''),   // 辅料单图(示例画稿[0]/示意图[1]),按位置随行入库
      attachment_files: form.attachment_files || [],           // 排版稿/文件附件(录料时随行入库)
      // 编辑模板带入行时,把 Override 原因一并写(action 同时记 overridden_at/by)
      ...(editId && editingTemplate ? { override_reason: form.override_reason || undefined } : {}),
    };
    const result = editId
      ? await updateBomItem(editId, orderId, payload)
      : await addBomItem(orderId, payload);
    if (result.error) { setError(result.error); }
    else { setShowAdd(false); setEditId(null); setEditingTemplate(false); setForm(emptyForm); await reload(); }
    setSaving(false);
  }

  async function handleDelete(id: string) {
    if (!confirm('确定删除此物料？')) return;
    await deleteBomItem(id, orderId);
    await reload();
  }

  async function handleSubmitProcurement() {
    if (!confirm('确认把原辅料单提交给采购？\n提交后会通知采购按 PO 数量汇总、询价、下单。')) return;
    setSubmitting(true); setSubmitMsg('');
    const res = await submitBomToProcurement(orderId);
    setSubmitting(false);
    if (res.error) { setSubmitMsg('提交失败：' + res.error); return; }
    const missing = (res as any).missing_consumption || [];
    setSubmitMsg(missing.length > 0
      ? `✅ 已提交采购（${res.count} 项），但 ⚠ ${missing.length} 行缺单耗、生成不了需求量：${missing.join('、')} —— 补上单耗后重新提交`
      : `✅ 已提交采购（${res.count} 项），采购已收到通知`);
    await reload();
  }

  async function toggleSample(item: any) {
    await setBomSampleGiven(item.id, orderId, !item.sample_given);
    await reload();
  }

  function startEdit(item: any) {
    setEditId(item.id);
    setEditingTemplate(!!item.product_bom_template_id);   // 来自产品款模板 → 编辑时显示 Override 原因
    setForm({
      material_name: item.material_name || '', material_type: item.material_type || 'other',
      material_code: item.material_code || '', placement: item.placement || '', color: item.color || '',
      qty_per_piece: item.qty_per_piece?.toString() || '',
      total_qty: item.total_qty?.toString() || '', unit: item.unit || 'meter', supplier: item.supplier || '',
      spec: item.spec || '', notes: item.notes || '', special_requirements: item.special_requirements || '',
      image_urls: (Array.isArray(item.image_urls) ? item.image_urls : []).map((u: any) => String(u || '')),
      attachment_files: Array.isArray(item.attachment_files) ? item.attachment_files : [],
      override_reason: item.override_reason || '', style_no: item.style_no || '',
      pack_size: item.pack_size != null ? String(item.pack_size) : '',
    });
    setShowAdd(true);
  }

  async function doInstantiate() {
    const replace = items.length > 0 && confirm('当前已有原辅料。\n确定 = 清空后从产品款实例化\n取消 = 追加(跳过已实例化的)');
    setInstantiating(true); setInstMsg('');
    const res = await instantiateOrderMaterialPackage(orderId, replace ? 'replace' : 'append');
    setInstantiating(false);
    if ((res as any).error) { setInstMsg('实例化失败：' + (res as any).error); return; }
    setInstMsg(`✅ 已从产品款实例化 ${(res as any).count} 行`);
    await reload();
  }

  async function openImport() {
    setShowImport(true); setImportMsg(''); setImportErr(''); setSelectedBrand('');
    setBrandLoading(true); setBrandData(null);
    const { data, error: err } = await getTrimLibraryBrands(orderId);
    if (err) { setImportErr(err); }
    else {
      setBrandData(data as any);
      // 默认选中：有品牌选第一个品牌，否则选通用
      if (data) setSelectedBrand(data.brands.length > 0 ? data.brands[0] : (data.hasGeneric ? GENERIC : ''));
    }
    setBrandLoading(false);
  }

  async function handleImport() {
    if (!selectedBrand) return;
    setImporting(true); setImportMsg(''); setImportErr('');
    const brand = selectedBrand === GENERIC ? null : selectedBrand;
    const res = await importFromTrimLibrary(orderId, brand);
    if (res.error) { setImportErr(res.error); }
    else {
      setImportMsg(`带入完成：新增 ${res.inserted} 条，跳过 ${res.skipped} 条（同名已存在）`);
      await reload();
    }
    setImporting(false);
  }

  function openMaster() {
    setShowMaster(true); setShowAdd(false); setShowImport(false); setShowCopy(false);
    setMasterSearch(''); setPicked(null); setMasterErr(''); setCreatingTemp(false);
    setMasterLoading(true);
    listMaterialMaster({}).then(res => { setMasterResults(res.data || []); setMasterLoading(false); });
  }

  // 实时搜索物料库（debounce 300ms，仅在搜索态、未选中具体物料时）
  useEffect(() => {
    if (!showMaster || picked) return;
    const t = setTimeout(async () => {
      setMasterLoading(true);
      const res = await listMaterialMaster({ search: masterSearch.trim() || undefined });
      setMasterResults(res.data || []); setMasterLoading(false);
    }, 300);
    return () => clearTimeout(t);
  }, [masterSearch, showMaster, picked]);

  function pickMaster(m: any) {
    setPicked(m); setMasterErr('');
    setPoForm({ qty_per_piece: m.default_consumption != null ? String(m.default_consumption) : '', color: '', placement: '', notes: '', special_requirements: '' });
  }

  async function saveFromMaster() {
    if (!picked) return;
    setMasterSaving(true); setMasterErr('');
    const res = await addBomItemFromMaster(orderId, picked.id, {
      qty_per_piece: poForm.qty_per_piece ? parseFloat(poForm.qty_per_piece) : undefined,
      color: poForm.color || undefined, placement: poForm.placement || undefined,
      notes: poForm.notes || undefined, special_requirements: poForm.special_requirements || undefined,
    });
    setMasterSaving(false);
    if (res.error) { setMasterErr(res.error); return; }
    setPicked(null); setShowMaster(false); await reload();
  }

  function openTempCreate(prefillName: string) {
    setTempForm({ ...emptyTempForm, material_name: prefillName || '' });
    setTempErr(''); setCreatingTemp(true);
  }
  const setT = (k: string, v: string) => setTempForm(f => ({ ...f, [k]: v }));

  async function saveTempCreate() {
    if (!tempForm.material_name.trim()) { setTempErr('物料名称不能为空'); return; }
    setTempSaving(true); setTempErr('');
    const res = await addTemporaryBomItem(orderId, {
      material_name: tempForm.material_name, category: tempForm.category,
      default_unit: tempForm.default_unit || undefined, specification: tempForm.specification || undefined,
      default_supplier_name: tempForm.default_supplier_name || undefined,
      qty_per_piece: tempForm.qty_per_piece ? parseFloat(tempForm.qty_per_piece) : undefined,
      color: tempForm.color || undefined, placement: tempForm.placement || undefined,
      notes: tempForm.notes || undefined, special_requirements: tempForm.special_requirements || undefined,
    });
    setTempSaving(false);
    if (res.error) { setTempErr(res.error); return; }
    setCreatingTemp(false); setShowMaster(false); await reload();
  }

  function openCopy() {
    setShowCopy(true); setShowAdd(false); setShowImport(false); setShowMaster(false);
    setCopySearch(''); setCopySource(null); setCopyPreview([]); setCopyMode('append'); setCopyErr('');
    setCopyLoading(true);
    listCopyableOrders(orderId).then(res => { setCopyOrders(res.data || []); setCopyLoading(false); });
  }

  // 搜索历史订单（debounce 300ms，列表态）
  useEffect(() => {
    if (!showCopy || copySource) return;
    const t = setTimeout(async () => {
      setCopyLoading(true);
      const res = await listCopyableOrders(orderId, copySearch.trim() || undefined);
      setCopyOrders(res.data || []); setCopyLoading(false);
    }, 300);
    return () => clearTimeout(t);
  }, [copySearch, showCopy, copySource, orderId]);

  async function selectCopySource(o: any) {
    setCopySource(o); setCopyErr(''); setCopyPreview([]);
    const { data } = await getBomItems(o.id);
    setCopyPreview(data || []);
  }

  async function doCopy() {
    if (!copySource) return;
    setCopySaving(true); setCopyErr('');
    const res = await copyBomFromOrder(orderId, copySource.id, items.length > 0 ? copyMode : 'append');
    setCopySaving(false);
    if (res.error) { setCopyErr(res.error); return; }
    setShowCopy(false); setCopySource(null); await reload();
  }

  // 尺码表(2026-07-08:改在 BOM 页上传,喂生产任务单)。
  // ⚠ Hooks 必须在任何早退(下面的 if (loading) return)之前声明,否则 loading→false 后
  //   本轮多跑几个 hook,React 报「Rendered more hooks than during the previous render」→ 整页崩。
  const [sizeCharts, setSizeCharts] = useState<Array<{ id: string; file_name: string; url: string | null }>>([]);
  const [scUploading, setScUploading] = useState(false);
  const [scMsg, setScMsg] = useState('');
  useEffect(() => { listSizeCharts(orderId).then(r => { if ((r as any).data) setSizeCharts((r as any).data); }); }, [orderId]);
  async function reloadSizeCharts() { const r = await listSizeCharts(orderId); if ((r as any).data) setSizeCharts((r as any).data); }
  async function handleUploadSizeCharts(files: FileList) {
    setScUploading(true); setScMsg('');
    let ok = 0; const errs: string[] = [];
    for (const file of Array.from(files)) {
      const fd = new FormData(); fd.set('file', file);
      const r = await uploadSizeChart(orderId, fd);
      if ((r as any).error) errs.push(`${file.name}:${(r as any).error}`); else ok++;
    }
    setScUploading(false);
    setScMsg(errs.length ? `已上传 ${ok} 个,失败 ${errs.length} 个 — ${errs[0]}` : '');
    await reloadSizeCharts();
  }
  async function handleDeleteSizeChart(id: string) {
    if (!confirm('删除这张尺码表？')) return;
    await deleteSizeChart(id, orderId);
    await reloadSizeCharts();
  }

  // 生成「辅料单」(第二张:辅料明细,读最新 BOM;自动同步到「生产任务单」页)
  const [trimBusy, setTrimBusy] = useState(false);
  const [trimMsg, setTrimMsg] = useState('');
  async function downloadTrimSheet() {
    setTrimBusy(true); setTrimMsg('');
    try {
      const res = await generateTrimSheet(orderId);
      if ((res as any).error) { setTrimMsg((res as any).error); return; }
      const { base64, fileName } = res as any;
      const bytes = atob(base64);
      const arr = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
      const blob = new Blob([arr], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = fileName; document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(url);
    } catch (e: any) { setTrimMsg('生成出错：' + (e?.message || e)); }
    finally { setTrimBusy(false); }
  }

  if (loading) return <div className="text-center py-8 text-gray-400">加载中...</div>;

  const submitted = items.some(i => i.submit_status === 'submitted');
  const submittedAt = items.find(i => i.submitted_at)?.submitted_at || null;

  const formRow = (
    <div className="bg-indigo-50 rounded-xl p-4 mb-4 space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <input placeholder="归属款号(空=整单通用)" value={form.style_no} onChange={e => set('style_no', e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        <input placeholder="物料名称 *" value={form.material_name} onChange={e => set('material_name', e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        <select value={form.material_type} onChange={e => set('material_type', e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm">
          {Object.entries(CAT_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <input placeholder="物料代码" value={form.material_code} onChange={e => set('material_code', e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        <input placeholder="供应商" value={form.supplier} onChange={e => set('supplier', e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        <input placeholder="位置说明(进辅料单)" title="辅料单「位置说明」列。如:左胸/后领中/侧缝" value={form.placement} onChange={e => set('placement', e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        <input placeholder="颜色 color" value={form.color} onChange={e => set('color', e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        <input placeholder="规格 spec" value={form.spec} onChange={e => set('spec', e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm md:col-span-2" />
        <input placeholder="备注 notes" value={form.notes} onChange={e => set('notes', e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm md:col-span-2" />
        <input placeholder="特殊要求" value={form.special_requirements} onChange={e => set('special_requirements', e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm md:col-span-2" />
      </div>
      {/* 辅料单图:两个槽按位置直传,保存随行入库;「生成辅料单」直接读进对应列 */}
      <div>
        <p className="text-xs text-gray-500 mb-1.5">🖼 辅料单图片（可选，上传后「生成辅料单」自动填入对应列）</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {([0, 1] as const).map(slot => {
            const url = form.image_urls?.[slot] || '';
            const label = slot === 0 ? '示例画稿（以实际为准）' : '位置说明及示意图';
            return (
              <div key={slot} className="flex items-center gap-3 rounded-lg border border-dashed border-indigo-300 bg-white p-2">
                {url
                  ? <img src={url} alt={label} className="w-16 h-16 object-cover rounded border border-gray-200" />
                  : <div className="w-16 h-16 rounded bg-gray-50 border border-gray-200 grid place-items-center text-[11px] text-gray-300">无图</div>}
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-gray-700 truncate">{label}</p>
                  <p className="text-[11px] text-gray-400">→ 辅料单「{label}」列</p>
                  <div className="flex items-center gap-2 mt-1.5">
                    <label className="text-xs px-2.5 py-1 rounded bg-indigo-600 text-white cursor-pointer hover:bg-indigo-700">
                      {formImgUploading === slot ? '上传中…' : (url ? '换图' : '上传图片')}
                      <input type="file" accept="image/*" className="hidden" disabled={formImgUploading !== null}
                        onChange={e => { const f = e.target.files?.[0]; if (f) uploadFormImage(slot, f); e.currentTarget.value = ''; }} />
                    </label>
                    {url && <button type="button" onClick={() => removeFormImage(slot)}
                      className="text-xs px-2 py-1 rounded border border-gray-200 text-gray-500 hover:text-red-500 hover:border-red-200">移除</button>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {/* 排版稿/文件附件(分款吊卡/箱唛等每款排版不同 → 传做好的稿;随行入库,归并带到采购,进采购单附件清单)*/}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-xs text-gray-500">📎 排版稿 / 文件附件（可选，PDF/AI/CDR/xlsx…；分款吊卡/箱唛用）</p>
          <label className={`text-xs px-2.5 py-1 rounded cursor-pointer font-medium ${formAttUploading ? 'bg-gray-100 text-gray-400' : 'bg-violet-600 text-white hover:bg-violet-700'}`}>
            {formAttUploading ? '上传中…' : '📎 上传附件'}
            <input type="file" accept=".pdf,.ai,.cdr,.eps,.svg,.psd,.xlsx,.xls,.csv,.doc,.docx,.zip,.rar,.png,.jpg,.jpeg" className="hidden" disabled={formAttUploading}
              onChange={e => { const f = e.target.files?.[0]; e.currentTarget.value = ''; if (f) uploadFormAttachment(f); }} />
          </label>
        </div>
        {(form.attachment_files || []).length === 0 ? (
          <p className="text-[11px] text-gray-400">暂无附件 — 有分款吊卡/箱唛排版稿在此上传;保存后随物料入库,采购归并时自动带过去。</p>
        ) : (
          <ul className="space-y-1">
            {(form.attachment_files || []).map((f, i) => (
              <li key={i} className="flex items-center gap-2 text-xs">
                <a href={f.url} target="_blank" rel="noreferrer" download className="text-violet-700 hover:underline truncate max-w-[22rem]" title={f.name}>📄 {f.name}</a>
                <button type="button" onClick={() => removeFormAttachment(f.url)} className="text-gray-300 hover:text-rose-500 leading-none shrink-0" title="移除">×</button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="grid grid-cols-3 gap-3">
        <input placeholder="单件用量" type="number" step="0.01" value={form.qty_per_piece} onChange={e => set('qty_per_piece', e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        <input placeholder="总需用量" type="number" step="0.01" value={form.total_qty} onChange={e => set('total_qty', e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        <input placeholder="单位" value={form.unit} onChange={e => set('unit', e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
      </div>
      {editId && editingTemplate && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 p-2">
          <input placeholder="Override 原因(本行来自产品款模板,改动会记录)" value={form.override_reason} onChange={e => set('override_reason', e.target.value)}
            className="w-full rounded-lg border border-amber-200 px-3 py-2 text-sm" />
        </div>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button onClick={handleSave} disabled={saving || !form.material_name.trim()}
          className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
          {saving ? '保存中...' : editId ? '更新' : '保存'}
        </button>
        <button onClick={() => { setShowAdd(false); setEditId(null); setEditingTemplate(false); setForm(emptyForm); setError(''); }}
          className="px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-500 hover:bg-gray-50">取消</button>
      </div>
    </div>
  );

  const importPanel = (
    <div className="bg-emerald-50 rounded-xl p-4 mb-4 space-y-3 border border-emerald-200">
      <div className="text-sm font-medium text-gray-700">📥 从客户标准库带入</div>
      {brandLoading ? (
        <p className="text-xs text-gray-400">读取客户标准库…</p>
      ) : importErr ? (
        <p className="text-xs text-red-600">{importErr}</p>
      ) : brandData && brandData.total === 0 ? (
        <p className="text-xs text-gray-500">
          客户「{brandData.customerName}」暂无标准辅料。请先在 <span className="font-medium">客户管理页 → 该客户 → 🧵 客户标准辅料库</span> 维护。
        </p>
      ) : brandData ? (
        <>
          <div className="text-xs text-gray-500">客户：<span className="font-medium text-gray-700">{brandData.customerName}</span>，选择品牌（含该客户通用辅料）：</div>
          <div className="flex flex-wrap gap-2">
            {brandData.brands.map(b => (
              <label key={b} className={`px-3 py-1.5 rounded-lg text-sm cursor-pointer border ${selectedBrand === b ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-gray-600 border-gray-200 hover:border-emerald-300'}`}>
                <input type="radio" name="brand" value={b} checked={selectedBrand === b} onChange={() => setSelectedBrand(b)} className="hidden" />
                {b}
              </label>
            ))}
            {brandData.hasGeneric && (
              <label className={`px-3 py-1.5 rounded-lg text-sm cursor-pointer border ${selectedBrand === GENERIC ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-gray-600 border-gray-200 hover:border-emerald-300'}`}>
                <input type="radio" name="brand" value={GENERIC} checked={selectedBrand === GENERIC} onChange={() => setSelectedBrand(GENERIC)} className="hidden" />
                仅通用辅料
              </label>
            )}
          </div>
          <p className="text-[11px] text-gray-400">规则：选品牌 = 带入该品牌 + 通用辅料；同名（名称+部位+颜色）已存在则跳过不覆盖；不带入数量/成本等订单级数据。</p>
          {importMsg && <p className="text-xs text-emerald-700 font-medium">{importMsg}</p>}
          <div className="flex gap-2">
            <button onClick={handleImport} disabled={importing || !selectedBrand}
              className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50">
              {importing ? '带入中…' : '确认带入'}
            </button>
            <button onClick={() => setShowImport(false)}
              className="px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-500 hover:bg-gray-50">关闭</button>
          </div>
        </>
      ) : null}
    </div>
  );

  const masterPanel = (
    <div className="bg-indigo-50 rounded-xl p-4 mb-4 border border-indigo-200">
      {creatingTemp ? (
        <>
          <div className="flex items-center gap-2 mb-3">
            <button onClick={() => setCreatingTemp(false)} className="text-xs text-indigo-600 hover:underline">← 返回搜索</button>
            <span className="text-sm font-medium text-gray-700">创建临时物料(加入本单)</span>
          </div>
          <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 mb-3">
            临时物料只服务本单、不进公司物料库;会出现在「物料主数据 → 待转正」,管理员审核后转正即可全公司复用。
          </p>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-gray-600 col-span-2">物料名称 *
              <input autoFocus value={tempForm.material_name} onChange={e => setT('material_name', e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
            <label className="text-xs text-gray-600">类别 *
              <select value={tempForm.category} onChange={e => setT('category', e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                {MASTER_CATS.map(c => <option key={c} value={c}>{CAT_LABEL[c]}</option>)}
              </select></label>
            <label className="text-xs text-gray-600">单位
              <input value={tempForm.default_unit} onChange={e => setT('default_unit', e.target.value)} placeholder="kg/pcs/m/yard"
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
            <label className="text-xs text-gray-600 col-span-2">规格
              <input value={tempForm.specification} onChange={e => setT('specification', e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
            <label className="text-xs text-gray-600 col-span-2">默认供应商(可选)
              <input value={tempForm.default_supplier_name} onChange={e => setT('default_supplier_name', e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
            <label className="text-xs text-gray-600">单耗(单件用量)
              <input type="number" step="0.0001" value={tempForm.qty_per_piece} onChange={e => setT('qty_per_piece', e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
            <label className="text-xs text-gray-600">颜色
              <input value={tempForm.color} onChange={e => setT('color', e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
            <label className="text-xs text-gray-600">位置(部位)
              <input value={tempForm.placement} onChange={e => setT('placement', e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
            <label className="text-xs text-gray-600">备注
              <input value={tempForm.notes} onChange={e => setT('notes', e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
            <label className="text-xs text-gray-600 col-span-2">特殊要求
              <input value={tempForm.special_requirements} onChange={e => setT('special_requirements', e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
          </div>
          {tempErr && <p className="text-xs text-red-600 mt-2">{tempErr}</p>}
          <div className="flex gap-2 mt-3">
            <button onClick={saveTempCreate} disabled={tempSaving || !tempForm.material_name.trim()}
              className="px-4 py-2 rounded-lg bg-amber-600 text-white text-sm font-medium hover:bg-amber-700 disabled:opacity-50">
              {tempSaving ? '保存中…' : '创建临时物料并加入本单'}</button>
            <button onClick={() => setCreatingTemp(false)}
              className="px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-500 hover:bg-gray-50">取消</button>
          </div>
        </>
      ) : !picked ? (
        <>
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm font-medium text-gray-700">🧱 从物料主数据选择</div>
            <button onClick={() => setShowMaster(false)} className="text-xs text-gray-400 hover:text-gray-600">关闭</button>
          </div>
          <input autoFocus placeholder="搜索物料名称 / 编码…" value={masterSearch} onChange={e => setMasterSearch(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm mb-3" />
          {masterLoading ? (
            <p className="text-xs text-gray-400 py-4 text-center">加载中…</p>
          ) : masterResults.length === 0 ? (
            <div className="py-4 text-center">
              <p className="text-xs text-gray-500 mb-3">物料库{masterSearch.trim() ? `搜不到「${masterSearch.trim()}」` : '暂无物料'}。</p>
              <button onClick={() => openTempCreate(masterSearch.trim())}
                className="px-4 py-2 rounded-lg bg-amber-600 text-white text-sm font-medium hover:bg-amber-700">+ 创建临时物料</button>
              <p className="text-[11px] text-gray-400 mt-2">临时物料加入本单并进「待转正」;或用「手动新增」先录(不挂主数据)。</p>
            </div>
          ) : (
            <div className="max-h-64 overflow-y-auto divide-y divide-indigo-100 bg-white rounded-lg border border-indigo-100">
              {masterResults.map(m => (
                <button key={m.id} onClick={() => pickMaster(m)}
                  className="w-full text-left py-2 px-3 hover:bg-indigo-50 flex items-center gap-2">
                  <span className="font-mono text-xs text-indigo-500 shrink-0 w-20">{m.material_code || '—'}</span>
                  <span className="font-medium text-gray-900 shrink-0">{m.material_name}</span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 shrink-0">{CAT_LABEL[m.category] || m.category}</span>
                  {m.stock_on_hand != null && m.stock_on_hand !== 0 && (
                    <span className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${m.stock_on_hand < 0 ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-700'}`} title="当前库存(所有颜色合计)">库存 {m.stock_on_hand}</span>
                  )}
                  <span className="text-xs text-gray-400 truncate">{m.specification || ''}</span>
                </button>
              ))}
            </div>
          )}
          {!masterLoading && masterResults.length > 0 && (
            <button onClick={() => openTempCreate(masterSearch.trim())}
              className="mt-2 text-xs text-amber-700 hover:underline">找不到?+ 创建临时物料</button>
          )}
        </>
      ) : (
        <>
          <div className="flex items-center gap-2 mb-3">
            <button onClick={() => setPicked(null)} className="text-xs text-indigo-600 hover:underline">← 返回</button>
            <span className="text-sm font-medium text-gray-700">填写本单信息</span>
          </div>
          {/* 只读：来自物料主数据的定义 */}
          <div className="bg-white rounded-lg border border-indigo-100 p-3 mb-3 text-xs text-gray-600 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-indigo-500">{picked.material_code || '—'}</span>
              <span className="font-medium text-gray-900">{picked.material_name}</span>
              <span className="px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">{CAT_LABEL[picked.category] || picked.category}</span>
            </div>
            <div>单位 {picked.default_unit || '—'} · 规格 {picked.specification || '—'} · 默认供应商 {picked.default_supplier_name || '—'}</div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-gray-600">单耗(单件用量)
              <input type="number" step="0.0001" value={poForm.qty_per_piece} onChange={e => setPoForm(f => ({ ...f, qty_per_piece: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
            <label className="text-xs text-gray-600">颜色
              <input value={poForm.color} onChange={e => setPoForm(f => ({ ...f, color: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
            <label className="text-xs text-gray-600">位置(部位)
              <input value={poForm.placement} onChange={e => setPoForm(f => ({ ...f, placement: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
            <label className="text-xs text-gray-600">备注
              <input value={poForm.notes} onChange={e => setPoForm(f => ({ ...f, notes: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
            <label className="text-xs text-gray-600 col-span-2">特殊要求
              <input value={poForm.special_requirements} onChange={e => setPoForm(f => ({ ...f, special_requirements: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
          </div>
          {masterErr && <p className="text-xs text-red-600 mt-2">{masterErr}</p>}
          <div className="flex gap-2 mt-3">
            <button onClick={saveFromMaster} disabled={masterSaving}
              className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
              {masterSaving ? '保存中…' : '保存到原辅料单'}</button>
            <button onClick={() => setPicked(null)}
              className="px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-500 hover:bg-gray-50">取消</button>
          </div>
        </>
      )}
    </div>
  );

  const copyPanel = (
    <div className="bg-violet-50 rounded-xl p-4 mb-4 border border-violet-200">
      {!copySource ? (
        <>
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm font-medium text-gray-700">📋 复制上一单原辅料</div>
            <button onClick={() => setShowCopy(false)} className="text-xs text-gray-400 hover:text-gray-600">关闭</button>
          </div>
          <input autoFocus placeholder="搜索订单号 / 客户 / 款号 / 产品…" value={copySearch} onChange={e => setCopySearch(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm mb-3" />
          {copyLoading ? (
            <p className="text-xs text-gray-400 py-4 text-center">加载中…</p>
          ) : copyOrders.length === 0 ? (
            <p className="text-xs text-gray-500 py-4 text-center">没有可复制的历史订单(候选订单需已录入原辅料)。</p>
          ) : (
            <div className="max-h-72 overflow-y-auto divide-y divide-violet-100 bg-white rounded-lg border border-violet-100">
              {copyOrders.map(o => (
                <button key={o.id} onClick={() => selectCopySource(o)}
                  className="w-full text-left py-2 px-3 hover:bg-violet-50 flex items-center gap-2 text-xs">
                  <span className="font-mono text-violet-600 shrink-0 w-28 truncate">{o.order_no}</span>
                  <span className="text-gray-700 shrink-0 w-24 truncate">{o.customer_name || '—'}</span>
                  <span className="text-gray-500 flex-1 truncate">{o.product_name || o.style_no || '—'}</span>
                  <span className="text-gray-400 shrink-0">{(o.etd || o.factory_date || '').slice(0, 10) || '—'}</span>
                  <span className="px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-700 shrink-0">{o.bom_count} 行</span>
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="flex items-center gap-2 mb-3">
            <button onClick={() => { setCopySource(null); setCopyPreview([]); }} className="text-xs text-violet-600 hover:underline">← 返回</button>
            <span className="text-sm font-medium text-gray-700">预览 {copySource.order_no} 的原辅料({copyPreview.length} 行)</span>
          </div>
          <div className="max-h-56 overflow-y-auto bg-white rounded-lg border border-violet-100 mb-3">
            <table className="w-full text-xs">
              <thead><tr className="border-b border-gray-100 text-gray-500">
                {['', '名称', '类别', '单耗', '单位', '颜色', '位置', '备注'].map((h, i) => (
                  <th key={i} className="py-1.5 px-2 text-left font-medium whitespace-nowrap">{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {copyPreview.map(r => (
                  <tr key={r.id} className="border-b border-gray-50">
                    <td className="py-1.5 px-2 whitespace-nowrap">{r.material_master_id ? (r.material_code ? '🔗' : '🔗临') : ''}</td>
                    <td className="py-1.5 px-2 font-medium text-gray-800">{r.material_name}</td>
                    <td className="py-1.5 px-2 text-gray-500">{CAT_LABEL[r.material_type] || r.material_type}</td>
                    <td className="py-1.5 px-2 text-gray-600">{r.qty_per_piece ?? '—'}</td>
                    <td className="py-1.5 px-2 text-gray-500">{r.unit || '—'}</td>
                    <td className="py-1.5 px-2 text-gray-500">{r.color || '—'}</td>
                    <td className="py-1.5 px-2 text-gray-500">{r.placement || '—'}</td>
                    <td className="py-1.5 px-2 text-gray-400 max-w-[120px] truncate">{r.notes || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {items.length > 0 && (
            <div className="flex items-center gap-4 text-xs mb-3">
              <span className="text-gray-500">当前订单已有 {items.length} 行:</span>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="radio" name="copyMode" checked={copyMode === 'append'} onChange={() => setCopyMode('append')} /> 追加
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="radio" name="copyMode" checked={copyMode === 'replace'} onChange={() => setCopyMode('replace')} />
                <span className="text-red-600">清空后复制</span>
              </label>
            </div>
          )}
          {copyErr && <p className="text-xs text-red-600 mb-2">{copyErr}</p>}
          <div className="flex gap-2">
            <button onClick={doCopy} disabled={copySaving || copyPreview.length === 0}
              className="px-4 py-2 rounded-lg bg-violet-600 text-white text-sm font-medium hover:bg-violet-700 disabled:opacity-50">
              {copySaving ? '复制中…' : `确认复制 ${copyPreview.length} 行${items.length > 0 && copyMode === 'replace' ? '(清空现有)' : ''}`}</button>
            <button onClick={() => { setCopySource(null); setCopyPreview([]); }}
              className="px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-500 hover:bg-gray-50">取消</button>
          </div>
        </>
      )}
    </div>
  );

  return (
    <div>
      {/* 尺码表:在此上传,生产任务单直接读取(2026-07-08:建单不再传尺码表) */}
      <div className="mb-4 p-3 rounded-xl border border-teal-200 bg-teal-50/40">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-gray-800">📏 尺码表</span>
          <span className="text-xs text-gray-500">在此上传,「生产任务单」直接读取(建单不再传)· 可一次选多个</span>
          <label className={`ml-auto text-sm px-3 py-1.5 rounded-lg bg-teal-600 text-white font-medium hover:bg-teal-700 cursor-pointer ${scUploading ? 'opacity-50 pointer-events-none' : ''}`}>
            {scUploading ? '上传中…' : '📤 上传尺码表'}
            <input type="file" multiple accept=".xlsx,.xls,.csv,.pdf,image/*" className="hidden" disabled={scUploading}
              onChange={e => { const fs = e.target.files; if (fs && fs.length) handleUploadSizeCharts(fs); e.currentTarget.value = ''; }} />
          </label>
        </div>
        {scMsg && <p className="text-xs text-rose-600 mt-1">{scMsg}</p>}
        {sizeCharts.length > 0 ? (
          <div className="mt-2 space-y-1">
            {sizeCharts.map(sc => (
              <div key={sc.id} className="flex items-center gap-2 text-sm">
                <span className="text-gray-400">📎</span>
                {sc.url
                  ? <a href={sc.url} target="_blank" rel="noopener noreferrer" className="text-teal-700 hover:underline truncate">{sc.file_name}</a>
                  : <span className="text-gray-600 truncate">{sc.file_name}</span>}
                <button onClick={() => handleDeleteSizeChart(sc.id)} className="ml-auto text-gray-300 hover:text-rose-500 text-xs" title="删除">✕</button>
              </div>
            ))}
          </div>
        ) : <p className="text-xs text-gray-400 mt-1">暂无尺码表,点右上「上传尺码表」。</p>}
      </div>
      {/* 辅料单(第二张):原辅料填完后在此生成,读最新 BOM;同一按钮也在「生产任务单」页 */}
      <div className="mb-4 p-3 rounded-xl border border-teal-200 bg-teal-50/40">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-gray-800">🧵 辅料单</span>
          <span className="text-xs text-gray-500">原辅料/包装填完后生成第二张「辅料单」(辅料明细,自动读最新 BOM),也会同步到「生产任务单」页</span>
          <button onClick={downloadTrimSheet} disabled={trimBusy || items.length === 0}
            className="ml-auto text-sm px-3 py-1.5 rounded-lg bg-teal-600 text-white font-medium hover:bg-teal-700 disabled:opacity-50"
            title={items.length === 0 ? '先录入原辅料再生成' : '生成辅料单(辅料明细)Excel'}>
            {trimBusy ? '生成中…' : '📋 生成辅料单'}
          </button>
        </div>
        {trimMsg && <p className="text-xs text-rose-600 mt-1">{trimMsg}</p>}
      </div>
      <div className="flex justify-between items-center mb-4">
        <span className="text-sm text-gray-500">{items.length} 条物料记录</span>
        {!showAdd && !showImport && !showMaster && !showCopy && !parseRows && (
          <div className="flex flex-wrap gap-2 justify-end">
            <label className={`text-sm px-3 py-1.5 rounded-lg bg-amber-500 text-white font-medium hover:bg-amber-600 cursor-pointer ${parsing ? 'opacity-50 pointer-events-none' : ''}`}>
              {parsing ? '识别中…' : '📄 上传原辅料单识别'}
              <input type="file" accept=".xlsx,.xls,.csv,.pdf,image/*" className="hidden" disabled={parsing} onChange={handleParseFile} />
            </label>
            <button onClick={doInstantiate} disabled={instantiating}
              className="text-sm px-3 py-1.5 rounded-lg bg-sky-600 text-white font-medium hover:bg-sky-700 disabled:opacity-50">{instantiating ? '实例化中…' : '🧬 从产品款实例化'}</button>
            <button onClick={openMaster}
              className="text-sm px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700">+ 从物料库选择</button>
            <button onClick={openCopy}
              className="text-sm px-3 py-1.5 rounded-lg border border-violet-300 text-violet-700 font-medium hover:bg-violet-50">📋 复制上一单</button>
            <button onClick={openImport}
              className="text-sm px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-medium hover:bg-emerald-700">📥 从客户标准库带入</button>
            <button onClick={() => { setShowAdd(true); setEditId(null); setEditingTemplate(false); setForm(emptyForm); }}
              className="text-sm px-3 py-1.5 rounded-lg border border-gray-300 text-gray-600 font-medium hover:bg-gray-50">手动新增</button>
          </div>
        )}
      </div>
      {instMsg && <p className="text-xs text-gray-600 mb-2">{instMsg}</p>}
      {/* 大货单耗核定(业务填·技术部大货版)—— 提交采购前填好,采购侧只读核实 + 填抛量(2026-07-06) */}
      {items.length > 0 && <BulkConsumptionEditor orderId={orderId} />}
      {/* 提交采购(采购流起点)*/}
      {items.length > 0 && (
        <div className="flex items-center justify-between gap-3 mb-4 p-3 rounded-xl border border-emerald-200 bg-emerald-50/40">
          <div className="text-sm min-w-0">
            {submitted ? (
              <span className="text-emerald-700 font-medium">
                ✅ 已提交采购{submittedAt ? `（${new Date(submittedAt).toLocaleString('zh-CN')}）` : ''}
              </span>
            ) : (
              <span className="text-gray-600">原辅料单录好后,提交给采购按 PO 数量汇总、询价、下单。</span>
            )}
            {submitMsg && <span className="block text-xs text-gray-500 mt-0.5">{submitMsg}</span>}
          </div>
          <button onClick={handleSubmitProcurement} disabled={submitting}
            className="shrink-0 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50">
            {submitting ? '提交中...' : submitted ? '重新提交采购' : '✅ 提交采购'}
          </button>
        </div>
      )}
      {parseErr && !parseRows && <p className="text-xs text-red-600 mb-2">❌ {parseErr}</p>}
      {/* 原辅料单识别结果:检查/修改/删行后批量入库 */}
      {parseRows && (
        <div className="mb-4 p-4 rounded-xl border border-amber-200 bg-amber-50/40">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-700">📄 识别结果:{parseFileName} · {parseRows.length} 行(可改可删,确认后入库)</span>
            <button onClick={() => { setParseRows(null); setParseErr(''); }} className="text-xs text-gray-400 hover:text-gray-600">关闭</button>
          </div>
          {parseNotes.length > 0 && (
            <p className="text-xs text-amber-700 mb-2">⚠ 需确认:{parseNotes.join('；')}</p>
          )}
          <div className="overflow-x-auto bg-white rounded-lg border border-amber-100 mb-3">
            <table className="w-full text-xs">
              <thead><tr className="border-b border-gray-100 text-gray-500">
                {['物料名称 *', '类别', '颜色', '规格', '单耗/件', '单位', '位置', '特殊要求', ''].map((h, i) => (
                  <th key={i} className="py-1.5 px-2 text-left font-medium whitespace-nowrap">{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {parseRows.map((r, i) => (
                  <tr key={i} className="border-b border-gray-50">
                    <td className="py-1 px-2"><input value={r.material_name || ''} onChange={e => setParseField(i, 'material_name', e.target.value)} className="w-36 rounded border border-gray-200 px-1.5 py-1" /></td>
                    <td className="py-1 px-2">
                      <select value={r.material_type || 'other'} onChange={e => setParseField(i, 'material_type', e.target.value)} className="rounded border border-gray-200 px-1 py-1 bg-white">
                        {Object.entries(CAT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </select>
                    </td>
                    <td className="py-1 px-2"><input value={r.color || ''} onChange={e => setParseField(i, 'color', e.target.value)} className="w-16 rounded border border-gray-200 px-1.5 py-1" /></td>
                    <td className="py-1 px-2"><input value={r.spec || ''} onChange={e => setParseField(i, 'spec', e.target.value)} className="w-20 rounded border border-gray-200 px-1.5 py-1" /></td>
                    <td className="py-1 px-2"><input value={r.qty_per_piece ?? ''} onChange={e => setParseField(i, 'qty_per_piece', e.target.value)} className="w-16 rounded border border-gray-200 px-1.5 py-1 text-right" /></td>
                    <td className="py-1 px-2"><input value={r.unit || ''} onChange={e => setParseField(i, 'unit', e.target.value)} className="w-12 rounded border border-gray-200 px-1.5 py-1" /></td>
                    <td className="py-1 px-2"><input value={r.placement || ''} onChange={e => setParseField(i, 'placement', e.target.value)} className="w-24 rounded border border-gray-200 px-1.5 py-1" /></td>
                    <td className="py-1 px-2"><input value={r.special_requirements || ''} onChange={e => setParseField(i, 'special_requirements', e.target.value)} className="w-40 rounded border border-gray-200 px-1.5 py-1" /></td>
                    <td className="py-1 px-2"><button onClick={() => removeParseRow(i)} className="text-red-500 hover:text-red-700">×</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {parseErr && <p className="text-xs text-red-600 mb-2">❌ {parseErr}</p>}
          <div className="flex gap-2">
            <button onClick={confirmBatchInsert} disabled={batchSaving || parseRows.length === 0}
              className="px-4 py-2 rounded-lg bg-amber-600 text-white text-sm font-medium hover:bg-amber-700 disabled:opacity-50">
              {batchSaving ? '入库中…' : `✅ 确认入库 ${parseRows.length} 行`}</button>
            <button onClick={() => { setParseRows(null); setParseErr(''); }}
              className="px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-500 hover:bg-gray-50">取消</button>
          </div>
        </div>
      )}
      {showMaster && masterPanel}
      {showCopy && copyPanel}
      {showImport && importPanel}
      {showAdd && formRow}
      {items.length === 0 && !showAdd && !showMaster && !showCopy && !parseRows ? (
        <div className="text-center py-12 text-gray-400">
          <p className="mb-2">暂无原辅料数据</p>
          <button onClick={openMaster} className="text-indigo-600 text-sm font-medium hover:underline">+ 从物料库选择录入</button>
        </div>
      ) : items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-gray-100">
              {['来源','物料代码','物料名称','类型','部位','颜色','图片/色卡','单件用量','总需','单位','供应商','规格','特殊要求','样品','操作'].map(h => (
                <th key={h} className="py-2 px-3 text-gray-500 font-medium text-left whitespace-nowrap">{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {/* S1.2 按款分组:每款一个原辅料表(第一行=同步的布料),整单通用排最后 */}
              {[...new Set(items.map((it: any) => it.style_no || ''))]
                .sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
                .flatMap(sk => {
                  const group = items.filter((it: any) => (it.style_no || '') === sk);
                  return [
                    <tr key={`grp-${sk}`} className="bg-indigo-50/70">
                      <td colSpan={15} className="py-1.5 px-3 text-xs font-semibold text-indigo-800">
                        {sk ? `👕 款 ${sk}` : '📦 整单通用'}（{group.length} 行）
                        <button onClick={() => { setShowAdd(true); setEditId(null); setEditingTemplate(false); setForm({ ...emptyForm, style_no: sk }); }}
                          className="ml-3 text-indigo-600 font-normal hover:underline">+ 加原辅料到{sk ? '此款' : '整单'}</button>
                      </td>
                    </tr>,
                    ...group.map(item => (
                <tr key={item.id} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="py-2 px-3 whitespace-nowrap">
                    {item.product_bom_template_id
                      ? (item.overridden_at
                          ? <span title={item.override_reason || '已改'} className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">✏️已改</span>
                          : <span title="来自产品款模板" className="text-xs px-2 py-0.5 rounded-full bg-sky-100 text-sky-700">🧬模板</span>)
                      : item.source === 'line_items_sync'
                        ? <span title="同步自逐款明细的布料;改布料去「逐款明细」改,这里改会被下次保存明细覆盖" className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">🧵布料同步</span>
                        : item.source === 'file_parse'
                          ? <span title="原辅料单 AI 识别入库" className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">📄识别</span>
                          : <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">手动</span>}
                  </td>
                  <td className="py-2 px-3 font-mono text-xs text-gray-500 whitespace-nowrap">
                    {item.material_master_id && (item.material_code
                      ? <span title="来自物料主数据">🔗 </span>
                      : <span title="临时物料(待转正)" className="text-amber-600 font-sans">🔗临时 </span>)}
                    {item.material_code || '—'}</td>
                  <td className="py-2 px-3 font-medium text-gray-900">{item.material_name}</td>
                  <td className="py-2 px-3"><span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">{CAT_LABEL[item.material_type] || item.material_type}</span></td>
                  <td className="py-2 px-3 text-gray-600">{item.placement || '—'}</td>
                  <td className="py-2 px-3 text-gray-600">{item.color || '—'}</td>
                  <td className="py-2 px-3">
                    <div className="flex items-center gap-1">
                      {(Array.isArray(item.image_urls) ? item.image_urls : []).slice(0, 3).map((u: string, i: number) => (
                        <a key={i} href={u} target="_blank" rel="noreferrer">
                          <img src={u} alt="色卡" className="w-7 h-7 rounded object-cover border border-gray-200 hover:scale-150 transition-transform" />
                        </a>
                      ))}
                      <label className={`text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 border border-indigo-200 cursor-pointer hover:bg-indigo-100 whitespace-nowrap ${imgUploadingId ? 'opacity-50 pointer-events-none' : ''}`}
                        title="上传色卡/辅料参考图">
                        {imgUploadingId === item.id ? '…' : '📷'}
                        <input type="file" accept="image/*" className="hidden" disabled={!!imgUploadingId}
                          onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadBomImage(item, f); e.currentTarget.value = ''; }} />
                      </label>
                      {/* 排版稿/文件附件(分款吊卡/箱唛等) */}
                      {(Array.isArray(item.attachment_files) ? item.attachment_files : []).map((f: any, i: number) => (
                        <a key={i} href={f.url} target="_blank" rel="noreferrer" download title={f.name}
                          className="text-[11px] text-indigo-600 hover:underline">📄</a>
                      ))}
                      <label className={`text-[10px] px-1.5 py-0.5 rounded bg-violet-50 text-violet-600 border border-violet-200 cursor-pointer hover:bg-violet-100 whitespace-nowrap ${attUploadingId ? 'opacity-50 pointer-events-none' : ''}`}
                        title="上传排版稿/文件附件(分款吊卡/箱唛等;PDF/AI/CDR/xlsx…)">
                        {attUploadingId === item.id ? '…' : '📎'}
                        <input type="file" accept=".pdf,.ai,.cdr,.eps,.svg,.psd,.xlsx,.xls,.csv,.doc,.docx,.zip,.rar,.png,.jpg,.jpeg" className="hidden" disabled={!!attUploadingId}
                          onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadBomAttachment(item, f); e.currentTarget.value = ''; }} />
                      </label>
                    </div>
                  </td>
                  <td className="py-2 px-3 text-gray-700">
                    {item.qty_per_piece ?? '—'}
                    {(() => { const o = overBaseline(item); return o ? (
                      <span title={`BOM 单耗 ${item.qty_per_piece} 超报价单耗 ${o.quote_consumption}（+${o.consumption_over_pct}%）· 核料确认时需财务审批`}
                        className="ml-1 inline-block px-1 py-px rounded text-[10px] font-medium bg-rose-100 text-rose-700 align-middle">⚠超报价+{o.consumption_over_pct}%</span>
                    ) : null; })()}
                  </td>
                  <td className="py-2 px-3 font-medium text-gray-900">
                    {item.total_qty != null && item.total_qty !== ''
                      ? item.total_qty
                      : item.computed_total_qty != null
                        ? (
                          <span title={`自动算:单件用量 ${item.qty_per_piece} × 件数 ${item.computed_pieces}${item.unit ? `（${item.unit}）` : ''}。件数来自订单明细,人工填「总需」可覆盖。`}
                            className="text-emerald-700">
                            {item.computed_total_qty}
                            <span className="ml-1 text-[10px] text-emerald-500 font-normal">自动</span>
                          </span>
                        )
                        : '—'}
                  </td>
                  <td className="py-2 px-3 text-gray-600">{item.unit}</td>
                  <td className="py-2 px-3 text-gray-500">{item.supplier || '—'}</td>
                  <td className="py-2 px-3 text-gray-500">{item.spec || '—'}</td>
                  <td className="py-2 px-3 text-gray-500 max-w-[140px] truncate" title={item.special_requirements || ''}>{item.special_requirements || '—'}</td>
                  <td className="py-2 px-3">
                    <button onClick={() => toggleSample(item)}
                      className={`text-xs px-2 py-0.5 rounded-full ${item.sample_given ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-400 hover:bg-gray-200'}`}
                      title="样品是否已线下交给采购">
                      {item.sample_given ? '已交样' : '未交样'}
                    </button>
                  </td>
                  <td className="py-2 px-3">
                    <div className="flex gap-1">
                      <button onClick={() => startEdit(item)} className="text-xs text-indigo-600 hover:underline">编辑</button>
                      <button onClick={() => handleDelete(item.id)} className="text-xs text-red-500 hover:underline">删除</button>
                    </div>
                  </td>
                </tr>
                    )),
                  ];
                })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
