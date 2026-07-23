'use client';
import { useEffect, useState } from 'react';
import { getBomItems, addBomItem, updateBomItem, deleteBomItem, getTrimLibraryBrands, importFromTrimLibrary, submitBomToProcurement, setBomSampleGiven, addBomItemFromMaster, addTemporaryBomItem, listCopyableOrders, copyBomFromOrder, instantiateOrderMaterialPackage } from '@/app/actions/bom';
import { BulkConsumptionEditor } from '@/components/BulkConsumptionEditor';
import { listMaterialMaster } from '@/app/actions/material-master';
import { getQuoteBaseline } from '@/app/actions/quote-baseline';
import { uploadSizeChart, listSizeCharts, deleteSizeChart, getSizeChartImport, reviewSizeChart, reparseSizeChart } from '@/app/actions/size-chart';
import { uploadOrderShareDoc, listOrderShareDocs, deleteOrderShareDoc } from '@/app/actions/order-share-docs';
import { bulkApproveExactCandidates, listAccessoryCandidates, reviewAccessoryCandidate } from '@/app/actions/accessory-import';
import { CartonSpecEditor } from '@/components/order/CartonSpecEditor';
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

const emptyForm = { material_name: '', material_type: 'fabric', material_code: '', placement: '', color: '', qty_per_piece: '', total_qty: '', unit: 'meter', supplier: '', spec: '', notes: '', special_requirements: '', override_reason: '', style_no: '', pack_size: '', image_urls: [] as string[], attachment_files: [] as Array<{ name: string; url: string }>, consumption_basis: '', sample_reference: '', position_description: '' };

// 带入弹窗用的「通用」哨兵值（区别于具体品牌字符串）
const GENERIC = '__generic__';

export function BomTab({ orderId }: { orderId: string }) {
  const [items, setItems] = useState<any[]>([]);
  const [openBatches, setOpenBatches] = useState<Record<string, boolean>>({});   // 已提交批次默认折叠,点开才展开
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
      consumption_basis: form.consumption_basis || undefined,
      sample_reference: form.sample_reference || undefined,
      position_description: form.position_description || undefined,
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
      consumption_basis: item.consumption_basis || '', sample_reference: item.sample_reference || '',
      position_description: item.position_description || '',
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
  const [sizeCharts, setSizeCharts] = useState<Array<{ id: string; file_name: string; url: string | null; parse_status: string; failure_reason: string | null; row_count: number; orientation: string | null; confidence: number | null; worksheet_name: string | null; size_count: number; measurement_count: number }>>([]);
  const [scUploading, setScUploading] = useState(false);
  const [scMsg, setScMsg] = useState('');
  const [scDetail, setScDetail] = useState<any | null>(null);
  const [scDiagnostic, setScDiagnostic] = useState<any | null>(null);
  const [scReparseForm, setScReparseForm] = useState({
    worksheetName: '',
    headerRow: '',
    orientation: '' as '' | 'horizontal' | 'vertical',
    sizeAxis: '' as '' | 'row' | 'column',
    measurementAxis: '' as '' | 'row' | 'column',
    ignoreRows: '',
  });
  useEffect(() => { listSizeCharts(orderId).then(r => { if ((r as any).data) setSizeCharts((r as any).data); }); }, [orderId]);
  async function reloadSizeCharts() { const r = await listSizeCharts(orderId); if ((r as any).data) setSizeCharts((r as any).data); }
  async function handleUploadSizeCharts(files: FileList) {
    setScUploading(true); setScMsg('');
    let ok = 0; const errs: string[] = [];
    try {
      for (const file of Array.from(files)) {
        const fd = new FormData(); fd.set('file', file);
        const r = await uploadSizeChart(orderId, fd);
        if ((r as any).error) errs.push(`${file.name}:${(r as any).error}`); else ok++;
      }
    } finally {
      setScUploading(false);
    }
    setScMsg(errs.length ? `已上传 ${ok} 个,失败 ${errs.length} 个 — ${errs[0]}` : '');
    await reloadSizeCharts();
  }
  async function handleDeleteSizeChart(id: string) {
    if (!confirm('删除这张尺码表？')) return;
    await deleteSizeChart(id, orderId);
    await reloadSizeCharts();
  }
  async function openSizeChartReview(id: string) {
    const r = await getSizeChartImport(id, orderId);
    const data = (r as any).data ? { ...(r as any).data, attachment_id: id } : null;
    setScDetail(data);
    setScReparseForm({
      worksheetName: data?.worksheet_name || '',
      headerRow: data?.parsed_json?.headerRow ? String(data.parsed_json.headerRow) : '',
      orientation: data?.parsed_json?.orientation || '',
      sizeAxis: '',
      measurementAxis: '',
      ignoreRows: '',
    });
  }
  async function decideSizeChart(id: string, decision: 'approve'|'reject') { const r = await reviewSizeChart(id, orderId, decision); if ((r as any).error) setScMsg((r as any).error); else { setScDetail(null); await reloadSizeCharts(); } }
  async function reparseOpenedSizeChart() {
    if (!scDetail?.attachment_id) return;
    const parsedHeaderRow = scReparseForm.headerRow ? Number(scReparseForm.headerRow) : undefined;
    const ignoreRows = scReparseForm.ignoreRows
      .split(/[,\s]+/g)
      .map((v) => Number(v))
      .filter((v) => Number.isInteger(v) && v > 0);
    const r = await reparseSizeChart(scDetail.attachment_id, orderId, {
      worksheetName: scReparseForm.worksheetName.trim() || null,
      headerRow: Number.isFinite(parsedHeaderRow as number) && (parsedHeaderRow as number) > 0 ? (parsedHeaderRow as number) : null,
      orientation: scReparseForm.orientation || null,
      sizeAxis: scReparseForm.sizeAxis || null,
      measurementAxis: scReparseForm.measurementAxis || null,
      ignoreRows: ignoreRows.length ? ignoreRows : null,
    });
    setScDiagnostic((r as any).data || { attachmentId: scDetail.attachment_id, updatedRecordId: null, updatedRowCount: 0, parserStatus: 'FAILED', error: (r as any).error || null });
    if ((r as any).error) { setScMsg((r as any).error); return; }
    const persisted = (r as any).data;
    setScDetail(persisted ? { ...persisted, attachment_id: scDetail.attachment_id } : null);
    await reloadSizeCharts();
  }

  // 订单共享文件:辅料采购清单 + 包装方式(整个 PO 上传一份,共享给采购/生产/财务)
  const [shareDocs, setShareDocs] = useState<Record<string, Array<{ id: string; file_name: string; url: string | null }>>>({});
  const [shareUploading, setShareUploading] = useState<string | null>(null);   // 正在上传的 file_type
  const [shareMsg, setShareMsg] = useState<Record<string, string>>({});
  const [candidates, setCandidates] = useState<any[]>([]);
  const [candidateFilter, setCandidateFilter] = useState('');
  async function reloadCandidates(status = candidateFilter) { const r = await listAccessoryCandidates(orderId, status || undefined); setCandidates((r as any).data || []); }
  useEffect(() => { reloadCandidates(); /* eslint-disable-next-line */ }, [orderId]);
  const SHARE_KINDS: Array<{ type: string; label: string; icon: string }> = [
    { type: 'accessory_purchase_list', label: '辅料采购清单', icon: '📋' },
    { type: 'packing_method', label: '包装方式', icon: '📦' },
  ];
  async function reloadShare(type: string) { const r = await listOrderShareDocs(orderId, type); setShareDocs(p => ({ ...p, [type]: (r as any).data || [] })); }
  useEffect(() => { SHARE_KINDS.forEach(k => reloadShare(k.type)); /* eslint-disable-next-line */ }, [orderId]);
  async function handleUploadShare(type: string, files: FileList) {
    setShareUploading(type); setShareMsg(p => ({ ...p, [type]: '' }));
    let ok = 0; const errs: string[] = [];
    for (const file of Array.from(files)) {
      const fd = new FormData(); fd.set('file', file);
      const r = await uploadOrderShareDoc(orderId, type, fd);
      if ((r as any).error) errs.push(`${file.name}:${(r as any).error}`); else { ok++; if ((r as any).warning) errs.push((r as any).warning); }
    }
    setShareUploading(null);
    setShareMsg(p => ({ ...p, [type]: errs.length ? `已上传 ${ok} 个,失败 ${errs.length} 个 — ${errs[0]}` : '' }));
    await reloadShare(type);
    if (type === 'accessory_purchase_list') await reloadCandidates();
  }
  async function reviewCandidate(c: any, action: 'approve'|'exclude') {
    const reason = action === 'exclude' ? prompt('排除原因（保留审计记录）') || '' : undefined;
    const r = await reviewAccessoryCandidate(c.id, orderId, action, c.extracted_value, reason);
    if ((r as any).error) alert((r as any).error); else { await reloadCandidates(); await reload(); }
  }
  async function editCandidate(c: any) {
    const name = prompt('辅料名称', c.extracted_value?.accessory_name || ''); if (!name) return;
    const spec = prompt('规格', c.extracted_value?.specification || '');
    const color = prompt('颜色', c.extracted_value?.color || '');
    const position = prompt('使用部位', c.extracted_value?.usage_position || '');
    const unit = prompt('单位', c.extracted_value?.unit || ''); if (!unit) return;
    const consumption = prompt('单耗', String(c.extracted_value?.unit_consumption ?? '')); if (!(Number(consumption) > 0)) return;
    const notes = prompt('备注', c.extracted_value?.notes || '');
    const special = prompt('特殊要求', c.extracted_value?.special_requirements || '');
    const sampleRef = prompt('样品/参考编号', c.extracted_value?.sample_reference || '');
    const positionDesc = prompt('位置说明', c.extracted_value?.position_description || '');
    const imageUrls = prompt('图片链接（逗号分隔，可留空）', Array.isArray(c.extracted_value?.image_urls) ? c.extracted_value.image_urls.join(',') : '');
    const attachmentFiles = prompt('画稿/附件链接（逗号分隔，可留空）', Array.isArray(c.extracted_value?.attachment_files) ? c.extracted_value.attachment_files.join(',') : '');
    const value = {
      ...c.extracted_value,
      accessory_name: name,
      specification: spec || null,
      color: color || null,
      usage_position: position || null,
      unit,
      unit_consumption: Number(consumption),
      notes: notes || null,
      special_requirements: special || null,
      sample_reference: sampleRef || null,
      position_description: positionDesc || null,
      image_urls: (imageUrls || '').split(/[，,]+/g).map((s) => s.trim()).filter(Boolean),
      attachment_files: (attachmentFiles || '').split(/[，,]+/g).map((s) => s.trim()).filter(Boolean),
    };
    const r = await reviewAccessoryCandidate(c.id, orderId, 'approve', value); if ((r as any).error) alert((r as any).error); else { await reloadCandidates(); await reload(); }
  }
  async function bulkApprove() { const r = await bulkApproveExactCandidates(orderId); if ((r as any).error) alert((r as any).error); else { alert(`已批准 ${(r as any).approved} 条精确完整匹配`); await reloadCandidates(); } }
  async function handleDeleteShare(type: string, id: string) {
    if (!confirm('删除这份文件？')) return;
    await deleteOrderShareDoc(id, orderId, type);
    await reloadShare(type);
  }

  // 生成「辅料单」(第二张:辅料明细,读最新 BOM;自动同步到「生产任务单」页)
  const [trimBusy, setTrimBusy] = useState(false);
  const [trimMsg, setTrimMsg] = useState('');
  // Keep form-scope state above the loading early return so Hook order is stable.
  const [byStyle, setByStyle] = useState(false);
  useEffect(() => { setByStyle(!!(form.style_no || '').trim()); /* eslint-disable-next-line */ }, [editId, showAdd]);
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
  // 2026-07-23:未提交的单独一栏「新增·待提交」;已提交的按 submitted_at 日期分批、每批可折叠(默认收起)
  const pendingItems = items.filter((i: any) => i.submit_status !== 'submitted');
  const submittedBatches: [string, any[]][] = (() => {
    const m = new Map<string, any[]>();
    for (const it of items) {
      if (it.submit_status !== 'submitted') continue;
      const key = it.submitted_at ? String(it.submitted_at).slice(0, 10) : '未知日期';
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(it);
    }
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));   // ISO 日期倒序,新批在前
  })();
  const fmtBatchDate = (k: string) => (k === '未知日期' ? k : new Date(k).toLocaleDateString('zh-CN'));
  const batchGroups: { key: string; type: 'pending' | 'submitted'; label: string; items: any[]; collapsible: boolean; collapsed: boolean }[] = [
    ...(pendingItems.length > 0 ? [{ key: 'pending', type: 'pending' as const, label: '🆕 新增 · 待提交采购', items: pendingItems, collapsible: false, collapsed: false }] : []),
    ...submittedBatches.map(([k, its]) => ({ key: k, type: 'submitted' as const, label: `✅ 已提交采购 · ${fmtBatchDate(k)}`, items: its, collapsible: true, collapsed: openBatches[k] !== true })),
  ];

  // 面料(含里料)= 完整表维持现状;辅料 = 精简为 款号/辅料名/单件数/总数(2026-07-11 用户拍板)
  const FULL_FORM_TYPES = ['fabric', 'lining'];
  const isFabricForm = FULL_FORM_TYPES.includes(form.material_type);
  const formRow = (
    <div className="bg-indigo-50 rounded-xl p-4 mb-4 space-y-3">
      {!isFabricForm && (
        <p className="text-xs text-gray-500">辅料只需填:辅料名 · 单件数量 · 总数量(单位默认「个」);面料才需规格/颜色/图片等。</p>
      )}
      {/* 范围切换:整单通用(主吊牌等所有款共用,录一次)/ 按款(每款不同) */}
      <div className="flex items-center gap-2 text-xs flex-wrap">
        <span className="text-gray-500">范围:</span>
        <button type="button" onClick={() => { setByStyle(false); set('style_no', ''); }}
          className={`px-3 py-1 rounded-full border font-medium ${!byStyle ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-600 border-gray-300'}`}>
          🏷 整单通用（所有款共用，如主吊牌）
        </button>
        <button type="button" onClick={() => setByStyle(true)}
          className={`px-3 py-1 rounded-full border font-medium ${byStyle ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-600 border-gray-300'}`}>
          📎 按款填（此款专属）
        </button>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {byStyle
          ? <input placeholder="归属款号 *" value={form.style_no} onChange={e => set('style_no', e.target.value)}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          : <div className="rounded-lg border border-dashed border-indigo-300 bg-white px-3 py-2 text-sm text-indigo-600 flex items-center">🏷 整单通用（不分款）</div>}
        <input placeholder={isFabricForm ? '物料名称 *' : '辅料名 *'} value={form.material_name} onChange={e => set('material_name', e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        <select value={form.material_type}
          onChange={e => { const t = e.target.value; setForm(f => ({ ...f, material_type: t, unit: FULL_FORM_TYPES.includes(t) ? (f.unit || 'meter') : '个' })); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm">
          {Object.entries(CAT_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        {isFabricForm && <>
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
        </>}
      </div>
      {isFabricForm && <>
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
      </>}
      <div className={`grid gap-3 ${isFabricForm ? 'grid-cols-3' : 'grid-cols-2'}`}>
        <input placeholder={isFabricForm ? '单件用量' : '单件数量(个数)'} type="number" step="0.01" value={form.qty_per_piece} onChange={e => set('qty_per_piece', e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        <input placeholder="总需用量" type="number" step="0.01" value={form.total_qty} onChange={e => set('total_qty', e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        {isFabricForm && <input placeholder="单位" value={form.unit} onChange={e => set('unit', e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 rounded-lg border border-indigo-100 bg-indigo-50/40 p-3">
        <select value={form.consumption_basis} onChange={e => set('consumption_basis', e.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm">
          <option value="">用量基准（历史/待确认）</option>
          <option value="PER_SET">每套</option><option value="PER_COMPONENT">每部件</option><option value="PER_PIECE">每件</option>
          <option value="PER_ORDER">整单</option><option value="PER_KG">每公斤</option><option value="PER_METER">每米</option>
          <option value="PER_PACK">每包</option><option value="MANUAL_TOTAL">手工总量</option>
        </select>
        <input placeholder="样品/参考编号" value={form.sample_reference} onChange={e => set('sample_reference', e.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        <textarea placeholder="详细位置说明" value={form.position_description} onChange={e => set('position_description', e.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
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
            <input type="file" multiple accept=".xlsx" className="hidden" disabled={scUploading}
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
                {sc.parse_status === 'PARSED' && <span className="text-[11px] rounded bg-sky-100 text-sky-700 px-1.5 py-0.5">解析成功 · {sc.row_count} 行</span>}
                {sc.parse_status === 'NEEDS_REVIEW' && <span className="text-[11px] rounded bg-amber-100 text-amber-700 px-1.5 py-0.5">需复核 · {sc.row_count} 行</span>}
                {sc.parse_status === 'FAILED' && <span className="text-[11px] rounded bg-amber-100 text-amber-700 px-1.5 py-0.5" title={sc.failure_reason || ''}>已上传 · 生产任务单将直接照搬此表(未自动识别尺码,不影响使用)</span>}
                {sc.parse_status === 'UPLOADED' && <span className="text-[11px] rounded bg-gray-100 text-gray-600 px-1.5 py-0.5">仅已上传</span>}
                {sc.parse_status === 'PARSING' && <span className="text-[11px] rounded bg-indigo-100 text-indigo-700 px-1.5 py-0.5">解析中</span>}
                {sc.parse_status === 'APPROVED' && <span className="text-[11px] rounded bg-emerald-100 text-emerald-700 px-1.5 py-0.5">已审核</span>}
                <span className="text-[11px] text-gray-400">{sc.orientation || '—'} · {sc.worksheet_name || '—'} · {sc.size_count}码/{sc.measurement_count}部位{sc.confidence != null ? ` · ${sc.confidence}%` : ''}</span>
                {sc.parse_status !== 'UPLOADED' && sc.parse_status !== 'PARSING' && <button onClick={() => openSizeChartReview(sc.id)} className="text-xs text-indigo-600 hover:underline">查看</button>}
                <button onClick={() => handleDeleteSizeChart(sc.id)} className="ml-auto text-gray-300 hover:text-rose-500 text-xs" title="删除">✕</button>
              </div>
            ))}
          </div>
        ) : <p className="text-xs text-gray-400 mt-1">暂无尺码表,点右上「上传尺码表」。</p>}
        {scDetail && <div className="mt-3 rounded-lg border bg-white p-3 text-xs space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold">工作表：{scDetail.worksheet_name || '—'} · {scDetail.parsed_row_count} 行</p>
            <span className="rounded bg-gray-100 text-gray-600 px-1.5 py-0.5">状态：{scDetail.parse_status}</span>
            {scDetail.parsed_json?.orientation && <span className="rounded bg-sky-100 text-sky-700 px-1.5 py-0.5">方向：{scDetail.parsed_json.orientation}</span>}
            {Number.isFinite(Number(scDetail.parsed_json?.confidence)) && <span className="rounded bg-indigo-100 text-indigo-700 px-1.5 py-0.5">置信度：{Math.round(Number(scDetail.parsed_json.confidence))}%</span>}
          </div>
          <div className="flex flex-wrap gap-2 text-[11px] text-gray-600">
            <span>尺码数：{scDetail.parsed_json?.sizeLabels?.length || 0}</span>
            <span>部位数：{scDetail.parsed_json?.measurementLabels?.length || 0}</span>
            {Array.isArray(scDetail.parsed_json?.warnings) && scDetail.parsed_json.warnings.length > 0 && <span className="text-amber-700">警告：{scDetail.parsed_json.warnings[0]}</span>}
            {Array.isArray(scDetail.parsed_json?.errors) && scDetail.parsed_json.errors.length > 0 && <span className="text-rose-700">错误：{scDetail.parsed_json.errors[0]}</span>}
          </div>
          {scDiagnostic && <div className="rounded border border-indigo-200 bg-indigo-50 p-2 text-[11px] text-indigo-900">
            <div className="font-semibold">管理员诊断（本次重新识别）</div>
            <div>attachmentId：{scDiagnostic.attachmentId || scDetail.attachment_id}</div>
            <div>updatedRecordId：{scDiagnostic.updatedRecordId || '—'} · updatedRowCount：{scDiagnostic.updatedRowCount ?? 0}</div>
            <div>action status：{scDiagnostic.parserStatus || '—'} · 页面当前读取：{scDetail.parse_status || '—'} · worksheet：{scDiagnostic.worksheet || scDetail.worksheet_name || '—'}</div>
            <div>sizeCount：{scDiagnostic.sizeCount ?? scDetail.parsed_json?.sizeLabels?.length ?? 0} · measurementCount：{scDiagnostic.measurementCount ?? scDetail.parsed_json?.measurementLabels?.length ?? 0}{scDiagnostic.error ? ` · error：${scDiagnostic.error}` : ''}</div>
          </div>}
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
            <label className="text-[11px] text-gray-500">worksheet
              <input value={scReparseForm.worksheetName} onChange={e => setScReparseForm(f => ({ ...f, worksheetName: e.target.value }))}
                className="mt-1 w-full rounded border px-2 py-1 text-xs" />
            </label>
            <label className="text-[11px] text-gray-500">header row
              <input value={scReparseForm.headerRow} onChange={e => setScReparseForm(f => ({ ...f, headerRow: e.target.value }))}
                className="mt-1 w-full rounded border px-2 py-1 text-xs" placeholder="如 2" />
            </label>
            <label className="text-[11px] text-gray-500">orientation
              <select value={scReparseForm.orientation} onChange={e => setScReparseForm(f => ({ ...f, orientation: e.target.value as any }))}
                className="mt-1 w-full rounded border px-2 py-1 text-xs">
                <option value="">自动</option>
                <option value="horizontal">横向</option>
                <option value="vertical">纵向</option>
              </select>
            </label>
            <label className="text-[11px] text-gray-500">size axis
              <select value={scReparseForm.sizeAxis} onChange={e => setScReparseForm(f => ({ ...f, sizeAxis: e.target.value as any }))}
                className="mt-1 w-full rounded border px-2 py-1 text-xs">
                <option value="">自动</option>
                <option value="row">行</option>
                <option value="column">列</option>
              </select>
            </label>
            <label className="text-[11px] text-gray-500">measurement axis
              <select value={scReparseForm.measurementAxis} onChange={e => setScReparseForm(f => ({ ...f, measurementAxis: e.target.value as any }))}
                className="mt-1 w-full rounded border px-2 py-1 text-xs">
                <option value="">自动</option>
                <option value="row">行</option>
                <option value="column">列</option>
              </select>
            </label>
            <label className="text-[11px] text-gray-500">ignore rows
              <input value={scReparseForm.ignoreRows} onChange={e => setScReparseForm(f => ({ ...f, ignoreRows: e.target.value }))}
                className="mt-1 w-full rounded border px-2 py-1 text-xs" placeholder="3,4,5" />
            </label>
          </div>
          <div className="overflow-x-auto"><table className="w-full"><tbody>{(scDetail.parsed_json?.rows || []).map((r: any, i: number) => <tr key={i} className="border-t"><td className="p-1 font-medium">{r.measurement}</td><td className="p-1 font-mono">{JSON.stringify(r.values)}</td></tr>)}</tbody></table></div>
          <div className="flex flex-wrap gap-2">
            <button onClick={reparseOpenedSizeChart} className="px-2 py-1 bg-indigo-600 text-white rounded">重新识别</button>
            <button onClick={() => decideSizeChart(scDetail.attachment_id, 'approve')} className="px-2 py-1 bg-emerald-600 text-white rounded">确认通过</button>
            <button onClick={() => decideSizeChart(scDetail.attachment_id, 'reject')} className="px-2 py-1 border rounded text-rose-600">复核不通过</button>
            <button onClick={() => setScDetail(null)} className="px-2 py-1 border rounded">关闭</button>
          </div>
        </div>}
      </div>
      {/* 订单共享文件:整个 PO 上传辅料采购清单 + 包装方式,共享给采购/生产/财务(2026-07-11:取代 AI 识别) */}
      <div className="mb-4 p-3 rounded-xl border border-violet-200 bg-violet-50/40">
        <p className="text-sm font-semibold text-gray-800 mb-1">📎 订单共享文件(业务对整个 PO 上传)</p>
        <p className="text-xs text-gray-500 mb-2">业务做好后在此上传,<b>共享给采购部 / 生产部 / 财务部</b>(采购核料页、生产任务单页也会显示下载)· 可选多个 · PDF/Excel/图片</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {SHARE_KINDS.map(k => {
            const list = shareDocs[k.type] || [];
            const busy = shareUploading === k.type;
            return (
              <div key={k.type} className="rounded-lg border border-violet-100 bg-white p-2.5">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-800">{k.icon} {k.label}</span>
                  <label className={`ml-auto text-xs px-2.5 py-1 rounded-lg bg-violet-600 text-white font-medium hover:bg-violet-700 cursor-pointer ${busy ? 'opacity-50 pointer-events-none' : ''}`}>
                    {busy ? '上传中…' : '📤 上传'}
                    <input type="file" multiple accept=".xlsx,.xls,.csv,.pdf,.doc,.docx,.png,.jpg,.jpeg,image/*" className="hidden" disabled={busy}
                      onChange={e => { const fs = e.target.files; if (fs && fs.length) handleUploadShare(k.type, fs); e.currentTarget.value = ''; }} />
                  </label>
                </div>
                {shareMsg[k.type] && <p className="text-xs text-rose-600 mt-1">{shareMsg[k.type]}</p>}
                {list.length > 0 ? (
                  <div className="mt-1.5 space-y-1">
                    {list.map(d => (
                      <div key={d.id} className="flex items-center gap-2 text-sm">
                        <span className="text-gray-400">📄</span>
                        {d.url
                          ? <a href={d.url} target="_blank" rel="noopener noreferrer" className="text-violet-700 hover:underline truncate">{d.file_name}</a>
                          : <span className="text-gray-600 truncate">{d.file_name}</span>}
                        <button onClick={() => handleDeleteShare(k.type, d.id)} className="ml-auto text-gray-300 hover:text-rose-500 text-xs" title="删除">✕</button>
                      </div>
                    ))}
                  </div>
                ) : <p className="text-xs text-gray-400 mt-1">暂无,点右上「上传」。</p>}
              </div>
            );
          })}
        </div>
      </div>
      {candidates.length > 0 && <div className="mb-4 p-3 rounded-xl border border-amber-200 bg-amber-50/40">
        <div className="flex items-center gap-2"><b className="text-sm">辅料导入候选审核</b><button onClick={bulkApprove} className="text-xs border rounded px-2 py-1 text-emerald-700">批量批准精确完整匹配</button><select value={candidateFilter} onChange={e => { setCandidateFilter(e.target.value); reloadCandidates(e.target.value); }} className="ml-auto text-xs border rounded p-1"><option value="">全部状态</option>{['SOURCE_IMPORTED','MATCHED_TO_EXISTING','NEW_ACCESSORY','NEEDS_REVIEW','APPROVED','EXCLUDED'].map(s => <option key={s}>{s}</option>)}</select></div>
        <div className="mt-2 overflow-x-auto"><table className="w-full text-xs"><thead><tr><th>源行</th><th>名称/规格/颜色/位置</th><th>状态</th><th>缺失/差异</th><th>图片/附件</th><th>匹配原因</th><th>操作</th></tr></thead><tbody>{candidates.map(c => <tr key={c.id} className="border-t"><td>{c.source_row_number}{c.order_attachments?.file_url && <a href={c.order_attachments.file_url} target="_blank" rel="noreferrer" className="ml-1 text-indigo-600">源文件</a>}</td><td>{c.extracted_value?.accessory_name} / {c.extracted_value?.specification || '—'} / {c.extracted_value?.color || '—'} / {c.extracted_value?.usage_position || '—'}<div className="text-[11px] text-gray-500">{c.extracted_value?.notes || c.extracted_value?.special_requirements ? [c.extracted_value?.notes, c.extracted_value?.special_requirements].filter(Boolean).join(' · ') : '—'}</div></td><td>{c.import_status}</td><td className="text-rose-600">{[...(c.missing_fields || []), ...((c.extracted_value?.difference_fields || []))].join('、') || '—'}</td><td>{Array.isArray(c.extracted_value?.image_urls) ? c.extracted_value.image_urls.length : 0} / {Array.isArray(c.extracted_value?.attachment_files) ? c.extracted_value.attachment_files.length : 0}</td><td>{c.extracted_value?.match_reason || '新辅料/待判断'}</td><td>{!['APPROVED','EXCLUDED'].includes(c.import_status) && <div className="flex gap-1"><button onClick={() => reviewCandidate(c,'approve')} className="text-emerald-700">批准</button><button onClick={() => editCandidate(c)} className="text-indigo-600">编辑并批准</button><button onClick={() => reviewCandidate(c,'exclude')} className="text-rose-600">排除</button></div>}</td></tr>)}</tbody></table></div>
        <p className="mt-2 text-[11px] text-amber-700">候选行不会自动生成采购单；批准新辅料只创建最小 BOM 记录。禁止在此点击最终提交采购。</p>
      </div>}
      {/* 纸箱规格 + 箱唛(#3:一套默认 + 个别款/色例外 + 箱唛模板,按款×色自动派生) */}
      <CartonSpecEditor orderId={orderId} />
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
        {!showAdd && !showImport && !showMaster && !showCopy && (
          <div className="flex flex-wrap gap-2 justify-end">
            {/* 2026-07-11 用户拍板:取消「原辅料单识别」(AI 识别不准),辅料改人工录入 + 上传辅料单文档 */}
            <button onClick={() => { setShowAdd(true); setEditId(null); setEditingTemplate(false); setForm(emptyForm); }}
              className="text-sm px-3 py-1.5 rounded-lg bg-amber-600 text-white font-medium hover:bg-amber-700">➕ 手动录入辅料</button>
            <button onClick={doInstantiate} disabled={instantiating}
              className="text-sm px-3 py-1.5 rounded-lg bg-sky-600 text-white font-medium hover:bg-sky-700 disabled:opacity-50">{instantiating ? '实例化中…' : '🧬 从产品款实例化'}</button>
            <button onClick={openMaster}
              className="text-sm px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700">+ 从物料库选择</button>
            <button onClick={openCopy}
              className="text-sm px-3 py-1.5 rounded-lg border border-violet-300 text-violet-700 font-medium hover:bg-violet-50">📋 复制上一单</button>
            <button onClick={openImport}
              className="text-sm px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-medium hover:bg-emerald-700">📥 从客户标准库带入</button>
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
            {pendingItems.length > 0 ? (
              <span className="text-amber-700 font-medium">🆕 有 {pendingItems.length} 项新增辅料待提交采购(提交后单独成一批,不与早先提交的混在一起)</span>
            ) : submitted ? (
              <span className="text-emerald-700 font-medium">✅ 已全部提交采购(按提交日期分批,见下方,默认折叠)</span>
            ) : (
              <span className="text-gray-600">原辅料单录好后,提交给采购按 PO 数量汇总、询价、下单。</span>
            )}
            {submitMsg && <span className="block text-xs text-gray-500 mt-0.5">{submitMsg}</span>}
          </div>
          <button onClick={handleSubmitProcurement} disabled={submitting}
            className="shrink-0 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50">
            {submitting ? '提交中...' : pendingItems.length > 0 ? `✅ 提交采购（${pendingItems.length} 项新增）` : submitted ? '重新提交采购' : '✅ 提交采购'}
          </button>
        </div>
      )}
      {showMaster && masterPanel}
      {showCopy && copyPanel}
      {showImport && importPanel}
      {showAdd && formRow}
      {items.length === 0 && !showAdd && !showMaster && !showCopy ? (
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
              {/* 2026-07-23:先按批次分组(🆕 新增·待提交 / ✅ 已提交·按日期,后者默认折叠),每批内再按款分组 */}
              {batchGroups.flatMap(bg => {
                const batchHeader = (
                  <tr key={`batch-${bg.key}`} className={bg.type === 'submitted' ? 'bg-emerald-50' : 'bg-amber-50'}>
                    <td colSpan={15} className="py-2 px-3">
                      {bg.collapsible ? (
                        <button onClick={() => setOpenBatches(s => ({ ...s, [bg.key]: !s[bg.key] }))}
                          className="flex items-center gap-1.5 text-xs font-semibold text-emerald-800 hover:underline">
                          <span className="text-[10px]">{bg.collapsed ? '▶' : '▼'}</span>{bg.label}（{bg.items.length} 项）
                          <span className="font-normal text-emerald-600">{bg.collapsed ? '· 点击展开' : '· 点击收起'}</span>
                        </button>
                      ) : (
                        <span className="text-xs font-semibold text-amber-800">{bg.label}（{bg.items.length} 项）· 填好后点右上「提交采购」并入已采购</span>
                      )}
                    </td>
                  </tr>
                );
                if (bg.collapsible && bg.collapsed) return [batchHeader];
                const styleRows = [...new Set(bg.items.map((it: any) => it.style_no || ''))]
                  .sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
                  .flatMap(sk => {
                  const group = bg.items.filter((it: any) => (it.style_no || '') === sk);
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
                          <span title={`自动算:每套用量 ${item.qty_per_piece} × 套数 ${item.computed_pieces}${item.unit ? `（${item.unit}）` : ''}。套数来自订单明细,人工填「总需」可覆盖。`}
                            className="text-emerald-700">
                            {item.computed_total_qty}
                            <span className="ml-1 text-[10px] text-emerald-500 font-normal">自动</span>
                          </span>
                        )
                        : '—'}
                    {item.quantity_issue && (
                      <div className="mt-0.5 text-[11px] text-amber-600" title={item.quantity_issue}>
                        {item.quantity_issue}
                      </div>
                    )}
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
                });
                return [batchHeader, ...styleRows];
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
