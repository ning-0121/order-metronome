'use client';
import { useEffect, useState } from 'react';
import { getBomItems, addBomItem, updateBomItem, deleteBomItem, getTrimLibraryBrands, importFromTrimLibrary, submitBomToProcurement, setBomSampleGiven, addBomItemFromMaster } from '@/app/actions/bom';
import { listMaterialMaster } from '@/app/actions/material-master';

// 10 值 material_type 中文 label(含 master 的 print/washing/embroidery/service)
const CAT_LABEL: Record<string, string> = {
  fabric: '面料', trim: '辅料', lining: '里料', label: '标签', packing: '包装',
  print: '印花', washing: '水洗', embroidery: '绣花', service: '服务', other: '其他',
};

const emptyForm = { material_name: '', material_type: 'fabric', material_code: '', placement: '', color: '', qty_per_piece: '', total_qty: '', unit: 'meter', supplier: '', spec: '', notes: '', special_requirements: '' };

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

  const reload = () => getBomItems(orderId).then(({ data }) => setItems(data || []));
  useEffect(() => { reload().then(() => setLoading(false)); }, [orderId]);

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
    };
    const result = editId
      ? await updateBomItem(editId, orderId, payload)
      : await addBomItem(orderId, payload);
    if (result.error) { setError(result.error); }
    else { setShowAdd(false); setEditId(null); setForm(emptyForm); await reload(); }
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
    setSubmitMsg(`✅ 已提交采购（${res.count} 项），采购已收到通知`);
    await reload();
  }

  async function toggleSample(item: any) {
    await setBomSampleGiven(item.id, orderId, !item.sample_given);
    await reload();
  }

  function startEdit(item: any) {
    setEditId(item.id);
    setForm({
      material_name: item.material_name || '', material_type: item.material_type || 'other',
      material_code: item.material_code || '', placement: item.placement || '', color: item.color || '',
      qty_per_piece: item.qty_per_piece?.toString() || '',
      total_qty: item.total_qty?.toString() || '', unit: item.unit || 'meter', supplier: item.supplier || '',
      spec: item.spec || '', notes: item.notes || '', special_requirements: item.special_requirements || '',
    });
    setShowAdd(true);
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
    setShowMaster(true); setShowAdd(false); setShowImport(false);
    setMasterSearch(''); setPicked(null); setMasterErr('');
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

  if (loading) return <div className="text-center py-8 text-gray-400">加载中...</div>;

  const submitted = items.some(i => i.submit_status === 'submitted');
  const submittedAt = items.find(i => i.submitted_at)?.submitted_at || null;

  const formRow = (
    <div className="bg-indigo-50 rounded-xl p-4 mb-4 space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
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
        <input placeholder="部位 placement" value={form.placement} onChange={e => set('placement', e.target.value)}
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
      <div className="grid grid-cols-3 gap-3">
        <input placeholder="单件用量" type="number" step="0.01" value={form.qty_per_piece} onChange={e => set('qty_per_piece', e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        <input placeholder="总需用量" type="number" step="0.01" value={form.total_qty} onChange={e => set('total_qty', e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        <input placeholder="单位" value={form.unit} onChange={e => set('unit', e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button onClick={handleSave} disabled={saving || !form.material_name.trim()}
          className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
          {saving ? '保存中...' : editId ? '更新' : '保存'}
        </button>
        <button onClick={() => { setShowAdd(false); setEditId(null); setForm(emptyForm); setError(''); }}
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
      {!picked ? (
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
            <div className="text-xs text-gray-500 py-4 text-center leading-relaxed">
              物料库暂无匹配。请去「<span className="font-medium">物料主数据</span>」页维护,
              或用「<span className="font-medium">手动新增</span>」先录入(不挂主数据)。
            </div>
          ) : (
            <div className="max-h-64 overflow-y-auto divide-y divide-indigo-100 bg-white rounded-lg border border-indigo-100">
              {masterResults.map(m => (
                <button key={m.id} onClick={() => pickMaster(m)}
                  className="w-full text-left py-2 px-3 hover:bg-indigo-50 flex items-center gap-2">
                  <span className="font-mono text-xs text-indigo-500 shrink-0 w-20">{m.material_code || '—'}</span>
                  <span className="font-medium text-gray-900 shrink-0">{m.material_name}</span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 shrink-0">{CAT_LABEL[m.category] || m.category}</span>
                  <span className="text-xs text-gray-400 truncate">{m.specification || ''}</span>
                </button>
              ))}
            </div>
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

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <span className="text-sm text-gray-500">{items.length} 条物料记录</span>
        {!showAdd && !showImport && !showMaster && (
          <div className="flex gap-2">
            <button onClick={openMaster}
              className="text-sm px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700">+ 从物料库选择</button>
            <button onClick={openImport}
              className="text-sm px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-medium hover:bg-emerald-700">📥 从客户标准库带入</button>
            <button onClick={() => { setShowAdd(true); setEditId(null); setForm(emptyForm); }}
              className="text-sm px-3 py-1.5 rounded-lg border border-gray-300 text-gray-600 font-medium hover:bg-gray-50">手动新增</button>
          </div>
        )}
      </div>
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
      {showMaster && masterPanel}
      {showImport && importPanel}
      {showAdd && formRow}
      {items.length === 0 && !showAdd && !showMaster ? (
        <div className="text-center py-12 text-gray-400">
          <p className="mb-2">暂无原辅料数据</p>
          <button onClick={openMaster} className="text-indigo-600 text-sm font-medium hover:underline">+ 从物料库选择录入</button>
        </div>
      ) : items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-gray-100">
              {['物料代码','物料名称','类型','部位','颜色','单件用量','总需','单位','供应商','规格','特殊要求','样品','操作'].map(h => (
                <th key={h} className="py-2 px-3 text-gray-500 font-medium text-left whitespace-nowrap">{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {items.map(item => (
                <tr key={item.id} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="py-2 px-3 font-mono text-xs text-gray-500 whitespace-nowrap">
                    {item.material_master_id && <span title="来自物料主数据">🔗 </span>}{item.material_code || '—'}</td>
                  <td className="py-2 px-3 font-medium text-gray-900">{item.material_name}</td>
                  <td className="py-2 px-3"><span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">{CAT_LABEL[item.material_type] || item.material_type}</span></td>
                  <td className="py-2 px-3 text-gray-600">{item.placement || '—'}</td>
                  <td className="py-2 px-3 text-gray-600">{item.color || '—'}</td>
                  <td className="py-2 px-3 text-gray-700">{item.qty_per_piece ?? '—'}</td>
                  <td className="py-2 px-3 font-medium text-gray-900">{item.total_qty ?? '—'}</td>
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
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
