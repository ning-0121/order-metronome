'use client';
import { useEffect, useState } from 'react';
import { getBomItems, addBomItem, updateBomItem, deleteBomItem, getTrimLibraryBrands, importFromTrimLibrary, submitBomToProcurement, setBomSampleGiven } from '@/app/actions/bom';

const TYPES = [
  { value: 'fabric', label: '面料' }, { value: 'trim', label: '辅料' },
  { value: 'lining', label: '里料' }, { value: 'label', label: '标签' },
  { value: 'packing', label: '包装' }, { value: 'other', label: '其他' },
];

const emptyForm = { material_name: '', material_type: 'fabric', material_code: '', placement: '', color: '', qty_per_piece: '', total_qty: '', unit: 'meter', supplier: '', spec: '' };

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
      spec: item.spec || '',
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
          {TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
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

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <span className="text-sm text-gray-500">{items.length} 条物料记录</span>
        {!showAdd && !showImport && (
          <div className="flex gap-2">
            <button onClick={openImport}
              className="text-sm px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-medium hover:bg-emerald-700">📥 从客户标准库带入</button>
            <button onClick={() => { setShowAdd(true); setEditId(null); setForm(emptyForm); }}
              className="text-sm px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700">+ 新增物料</button>
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
      {showImport && importPanel}
      {showAdd && formRow}
      {items.length === 0 && !showAdd ? (
        <div className="text-center py-12 text-gray-400">
          <p className="mb-2">暂无 BOM 数据</p>
          <button onClick={() => setShowAdd(true)} className="text-indigo-600 text-sm font-medium hover:underline">+ 录入物料清单</button>
        </div>
      ) : items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-gray-100">
              {['物料代码','物料名称','类型','部位','颜色','单件用量','总需','单位','供应商','规格','样品','操作'].map(h => (
                <th key={h} className="py-2 px-3 text-gray-500 font-medium text-left whitespace-nowrap">{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {items.map(item => (
                <tr key={item.id} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="py-2 px-3 font-mono text-xs text-gray-500">{item.material_code || '—'}</td>
                  <td className="py-2 px-3 font-medium text-gray-900">{item.material_name}</td>
                  <td className="py-2 px-3"><span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">{TYPES.find(t=>t.value===item.material_type)?.label || item.material_type}</span></td>
                  <td className="py-2 px-3 text-gray-600">{item.placement || '—'}</td>
                  <td className="py-2 px-3 text-gray-600">{item.color || '—'}</td>
                  <td className="py-2 px-3 text-gray-700">{item.qty_per_piece ?? '—'}</td>
                  <td className="py-2 px-3 font-medium text-gray-900">{item.total_qty ?? '—'}</td>
                  <td className="py-2 px-3 text-gray-600">{item.unit}</td>
                  <td className="py-2 px-3 text-gray-500">{item.supplier || '—'}</td>
                  <td className="py-2 px-3 text-gray-500">{item.spec || '—'}</td>
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
