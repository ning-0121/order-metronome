'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import {
  listMaterialMaster, createMaterialMaster, updateMaterialMaster, archiveMaterialMaster,
  deleteMaterialMaster, bulkImportMaterials,
  listPendingPromotion, promoteTemporaryMaterial, canManageMaster, findSimilarMaterials, type MasterInput,
} from '@/app/actions/material-master';
import { parseExcelFile, downloadExcelTemplate, pickCell, importResultText } from '@/lib/utils/excel-import';
import { MaterialDetailPanel } from './MaterialDetailPanel';

const CATEGORIES: { value: string; label: string }[] = [
  { value: 'fabric', label: '面料' }, { value: 'trim', label: '辅料' },
  { value: 'packing', label: '包装' }, { value: 'print', label: '印花' },
  { value: 'washing', label: '洗水' }, { value: 'embroidery', label: '绣花' },
  { value: 'service', label: '服务' }, { value: 'other', label: '其他' },
];
const catLabel = (c: string) => CATEGORIES.find(x => x.value === c)?.label || c;
// 常用单位(下拉预置 + 可「➕添加新单位」自由填)
const UNIT_SUGGEST = ['米', '码', 'kg', '克', '件', '个', '套', '打', '条', '卷', '张', '双'];
const emptyForm: MasterInput = { material_name: '', category: 'fabric', default_unit: '', default_lead_days: '', specification: '', reference_price: '' };

export default function MaterialMasterPage() {
  const [tab, setTab] = useState<'lib' | 'pending'>('lib');
  const [canManage, setCanManage] = useState(false);
  const [rows, setRows] = useState<any[]>([]);
  const [pending, setPending] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [msg, setMsg] = useState('');

  // 新建/编辑表单
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editingCode, setEditingCode] = useState<string | null>(null);
  const [form, setForm] = useState<MasterInput>(emptyForm);
  const [saving, setSaving] = useState(false);
  // 类别/单位:'preset'=从下拉选,'custom'=选了「➕添加新的」→ 显示输入框自由填
  const [catMode, setCatMode] = useState<'preset' | 'custom'>('preset');
  const [unitMode, setUnitMode] = useState<'preset' | 'custom'>('preset');
  const [similar, setSimilar] = useState<any[] | null>(null);
  const [detailMat, setDetailMat] = useState<any | null>(null); // SC-P1 供应链详情抽屉

  const loadLib = useCallback(async () => {
    setLoading(true);
    const res = await listMaterialMaster({ search, category });
    if (res.data) setRows(res.data);
    setLoading(false);
  }, [search, category]);

  const loadPending = useCallback(async () => {
    const res = await listPendingPromotion();
    if (res.data) setPending(res.data);
  }, []);

  useEffect(() => { canManageMaster().then(setCanManage); }, []);
  useEffect(() => { if (tab === 'lib') loadLib(); else loadPending(); }, [tab, loadLib, loadPending]);

  function openNew() { setEditId(null); setEditingCode(null); setForm(emptyForm); setCatMode('preset'); setUnitMode('preset'); setSimilar(null); setShowForm(true); }
  function openEdit(r: any) {
    setEditId(r.id); setEditingCode(r.material_code || null);
    setForm({ material_name: r.material_name || '', category: r.category || 'other', default_unit: r.default_unit || '', default_lead_days: r.default_lead_days ?? '', specification: r.specification || '', reference_price: r.reference_price ?? '' });
    // 已有值不在预置列表 → 进自定义模式(显示输入框回填)
    setCatMode(CATEGORIES.some(c => c.value === r.category) ? 'preset' : 'custom');
    setUnitMode(!r.default_unit || UNIT_SUGGEST.includes(r.default_unit) ? 'preset' : 'custom');
    setSimilar(null); setShowForm(true);
  }

  // 实时相似搜索:输入名称即查(debounce 300ms),仅新建时
  useEffect(() => {
    if (!showForm || editId) { setSimilar(null); return; }
    const name = (form.material_name || '').trim();
    if (name.length < 2) { setSimilar(null); return; }
    const t = setTimeout(async () => {
      const res = await findSimilarMaterials(name, form.category, form.specification || undefined);
      setSimilar(res.data || []);
    }, 300);
    return () => clearTimeout(t);
  }, [form.material_name, form.category, form.specification, showForm, editId]);

  async function save(force = false) {
    setSaving(true); setMsg('');
    // 2026-07-03 防重复:不再无条件 force。完全同名同类别服务端直接拒绝;
    // 模糊相似 → 返回 similar 面板,用户点「继续创建」才 force。
    const res = editId
      ? await updateMaterialMaster(editId, form)
      : await createMaterialMaster(form, { force });
    setSaving(false);
    if ((res as any).duplicate) {
      const d = (res as any).duplicate;
      setMsg('');
      alert(`⚠️ 物料已存在,不能重复创建:\n${d.material_code || '无编码'} ${d.material_name}${d.specification ? ' · ' + d.specification : ''}\n\n请在列表里直接使用/编辑它。`);
      setShowForm(false); setSearch(d.material_name); loadLib();
      return;
    }
    if ((res as any).similar) { setSimilar((res as any).similar); return; }  // 展示相似面板,等用户决定
    if (res.error) { setMsg('保存失败：' + res.error); return; }
    setShowForm(false); setSimilar(null);
    setMsg(editId ? '✅ 已更新' : `✅ 已新建（编号 ${(res as any).data?.material_code || ''}）`);
    loadLib();
  }

  async function archive(r: any) {
    if (!confirm(`归档物料「${r.material_name}」？归档后不再出现在搜索/录入中（数据保留）。`)) return;
    const res = await archiveMaterialMaster(r.id);
    if (res.error) { alert(res.error); return; }
    loadLib();
  }

  async function remove(r: any) {
    if (!confirm(`删除物料「${r.material_name}」(${r.material_code || '无编码'})？\n未被订单BOM/采购引用才能删;已被引用请用「归档」。`)) return;
    const res = await deleteMaterialMaster(r.id);
    if (res.error) { alert(res.error); return; }
    setMsg(`✅ 已删除「${r.material_name}」`);
    loadLib();
  }

  // Excel 批量导入
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ summary: string; details: Array<{ row: number; name: string; reason: string }> } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // ⚡ 页面内批量录入(不用 Excel):多行表格一键提交,复用 bulkImportMaterials 同查重同报告
  const emptyBatchRow = () => ({ material_name: '', category: 'fabric', default_unit: '', specification: '', reference_price: '', default_lead_days: '' });
  const [batchRows, setBatchRows] = useState<any[] | null>(null);
  const [batchSaving, setBatchSaving] = useState(false);
  const setBatchCell = (i: number, k: string, v: string) =>
    setBatchRows(rows => (rows || []).map((r, x) => x === i ? { ...r, [k]: v } : r));

  async function submitBatch() {
    const rows = (batchRows || []).filter(r => String(r.material_name || '').trim());
    if (rows.length === 0) { alert('至少填一行物料名称'); return; }
    setBatchSaving(true); setImportResult(null); setMsg('');
    const res = await bulkImportMaterials(rows as any);
    setBatchSaving(false);
    if (res.error) { alert(res.error); return; }
    setImportResult({ summary: importResultText(res), details: [...(res.skipped || []), ...(res.failed || [])] });
    if ((res.created || 0) > 0) setBatchRows(null);   // 有成功→收起;全被跳过→留着改
    loadLib();
  }
  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImporting(true); setImportResult(null); setMsg('');
    try {
      const parsed = await parseExcelFile(file);
      const labelToValue = (label: string) => CATEGORIES.find(c => c.label === label.trim())?.value || label.trim();
      const inputs = parsed.map(r => ({
        material_name: pickCell(r, ['物料名称', '名称']),
        category: labelToValue(pickCell(r, ['类别', '分类'])),
        default_unit: pickCell(r, ['单位']),
        specification: pickCell(r, ['规格', '成分']),
        reference_price: pickCell(r, ['参考价']) as any,
        default_loss_rate: pickCell(r, ['默认损耗率', '损耗率', '损耗']) as any,
        default_lead_days: pickCell(r, ['默认交期', '交期']) as any,
      })).filter(x => Object.values(x).some(v => String(v || '').trim()));
      if (inputs.length === 0) { alert('文件里没有读到数据行 — 请用「下载模板」的格式填写'); return; }
      const res = await bulkImportMaterials(inputs as any);
      if (res.error) { alert(res.error); return; }
      setImportResult({ summary: importResultText(res), details: [...(res.skipped || []), ...(res.failed || [])] });
      loadLib();
    } catch (err: any) {
      alert('文件解析失败:' + (err?.message || '请确认是 .xlsx/.xls/.csv 文件'));
    } finally {
      setImporting(false);
    }
  }

  const [promoting, setPromoting] = useState<string | null>(null);
  const [promoteSimilar, setPromoteSimilar] = useState<{ id: string; similar: any[] } | null>(null);
  async function promote(id: string, force = false) {
    setPromoting(id); setPromoteSimilar(null);
    const res = await promoteTemporaryMaterial(id, { force });
    setPromoting(null);
    if ((res as any).similar) { setPromoteSimilar({ id, similar: (res as any).similar }); return; }
    if (res.error) { alert(res.error); return; }
    setMsg(`✅ 已转正（${(res as any).data?.material_code || ''}）`);
    loadPending();
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-gray-900">🧱 物料主数据</h1>
        <p className="text-sm text-gray-500 mt-1">公司级可复用物料库。录入原辅料时从这里「选」,不用重敲定义。空起步,随录入逐步沉淀。</p>
      </div>

      <div className="flex items-center gap-2 mb-4 border-b border-gray-200">
        {([['lib', '物料库'], ['pending', `待转正${pending.length ? ' (' + pending.length + ')' : ''}`]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k as any)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${tab === k ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-gray-500 hover:text-gray-800'}`}>
            {label}
          </button>
        ))}
      </div>

      {msg && <div className="mb-3 text-sm text-emerald-700">{msg}</div>}

      {tab === 'lib' && (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <input value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => e.key === 'Enter' && loadLib()}
              placeholder="搜索 名称 / 编码…" className="flex-1 min-w-[180px] rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            <select value={category} onChange={e => setCategory(e.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm">
              <option value="">全部类别</option>
              {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
            <button onClick={loadLib} className="px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50">搜索</button>
            <button onClick={openNew} className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700">+ 新建物料</button>
            {canManage && <>
              <button onClick={() => setBatchRows(batchRows ? null : Array.from({ length: 5 }, emptyBatchRow))}
                className="px-3 py-2 rounded-lg bg-indigo-500 text-white text-sm font-medium hover:bg-indigo-600">
                {batchRows ? '收起批量' : '⚡ 批量录入'}
              </button>
              <button onClick={() => downloadExcelTemplate('物料导入模板.xlsx',
                ['物料名称*', '类别*', '单位', '规格(成分/克重)', '参考价(不含税)', '默认损耗率%', '默认交期(天)'],
                [['例:280g仿锦棉', '面料', '米', '96%锦纶4%氨纶 280g', '23.5', '3', '15']])}
                className="px-3 py-2 rounded-lg border border-gray-300 text-sm text-gray-600 hover:bg-gray-50">📄 模板</button>
              <button onClick={() => fileRef.current?.click()} disabled={importing}
                className="px-3 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50">
                {importing ? '导入中…' : '📥 Excel 导入'}
              </button>
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleImportFile} />
            </>}
          </div>

          {batchRows && (
            <div className="mb-4 rounded-xl border border-indigo-200 bg-indigo-50/30 p-3 space-y-2">
              <p className="text-xs text-gray-600">⚡ 批量录入:名称+类别必填;同名同类别同规格自动跳过;编码自动生成。布料变体(不同克重)在「规格」里区分。</p>
              <div className="overflow-x-auto">
                <table className="text-xs w-full">
                  <thead><tr className="text-gray-400 text-left">
                    {['名称 *', '类别 *', '单位', '规格(克重/门幅)', '参考价(净)', '交期(天)'].map(h => (
                      <th key={h} className="px-1 py-1 font-medium whitespace-nowrap">{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {batchRows.map((r, i) => (
                      <tr key={i}>
                        <td className="px-1 py-0.5"><input value={r.material_name} onChange={e => setBatchCell(i, 'material_name', e.target.value)} placeholder="仿锦直贡呢拉毛" className="w-full min-w-[140px] rounded border border-gray-300 px-2 py-1.5 bg-white" /></td>
                        <td className="px-1 py-0.5">
                          <select value={r.category} onChange={e => setBatchCell(i, 'category', e.target.value)} className="w-20 rounded border border-gray-300 px-1 py-1.5 bg-white">
                            {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                          </select>
                        </td>
                        <td className="px-1 py-0.5"><input value={r.default_unit} onChange={e => setBatchCell(i, 'default_unit', e.target.value)} placeholder="米/kg/个" className="w-16 rounded border border-gray-300 px-2 py-1.5 bg-white" /></td>
                        <td className="px-1 py-0.5"><input value={r.specification} onChange={e => setBatchCell(i, 'specification', e.target.value)} placeholder="260g 门幅150" className="w-32 rounded border border-gray-300 px-2 py-1.5 bg-white" /></td>
                        <td className="px-1 py-0.5"><input type="number" step="any" value={r.reference_price} onChange={e => setBatchCell(i, 'reference_price', e.target.value)} className="w-20 rounded border border-gray-300 px-2 py-1.5 bg-white" /></td>
                        <td className="px-1 py-0.5"><input type="number" value={r.default_lead_days} onChange={e => setBatchCell(i, 'default_lead_days', e.target.value)} className="w-16 rounded border border-gray-300 px-2 py-1.5 bg-white" /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex gap-2">
                <button onClick={() => setBatchRows([...batchRows, emptyBatchRow()])} className="text-xs text-indigo-600 hover:underline">+ 加行</button>
                <button onClick={submitBatch} disabled={batchSaving}
                  className="ml-auto px-4 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-semibold hover:bg-indigo-700 disabled:opacity-50">
                  {batchSaving ? '提交中…' : `提交(${batchRows.filter(r => String(r.material_name || '').trim()).length} 条)`}
                </button>
              </div>
            </div>
          )}

          {importResult && (
            <div className="mb-4 text-xs bg-gray-50 border border-gray-200 rounded-lg p-3 space-y-1">
              <p className="font-medium text-gray-800">{importResult.summary}</p>
              {importResult.details.slice(0, 20).map((d, i) => (
                <p key={i} className="text-gray-500">第{d.row}行「{d.name}」：{d.reason}</p>
              ))}
              {importResult.details.length > 20 && <p className="text-gray-400">…还有 {importResult.details.length - 20} 条</p>}
            </div>
          )}

          {loading ? <div className="text-center py-10 text-gray-400">加载中...</div> : rows.length === 0 ? (
            <div className="text-center py-12 text-gray-400 text-sm">
              暂无物料主数据。点「+ 新建物料」录入,或在订单录入原辅料时新建物料会沉淀到这里。
            </div>
          ) : (
            <div className="overflow-x-auto bg-white rounded-xl border border-gray-200">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-gray-100 text-left text-gray-500">
                  {['编码', '名称', '类别', '单位', '参考价(净)', '交期', '规格', '用过', '录入', ''].map(h => (
                    <th key={h} className="py-2 px-3 font-medium whitespace-nowrap">{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id} className="border-b border-gray-50 hover:bg-gray-50">
                      <td className="py-2 px-3 font-mono text-xs text-gray-500">{r.material_code || '—'}</td>
                      <td className="py-2 px-3 font-medium text-gray-900">{r.material_name}</td>
                      <td className="py-2 px-3"><span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">{catLabel(r.category)}</span></td>
                      <td className="py-2 px-3 text-gray-600">{r.default_unit || '—'}</td>
                      <td className="py-2 px-3 text-gray-700">{r.reference_price != null ? `¥${r.reference_price}` : '—'}</td>
                      <td className="py-2 px-3 text-gray-600">{r.default_lead_days ?? '—'}</td>
                      <td className="py-2 px-3 text-gray-500 max-w-[160px] truncate">{r.specification || '—'}</td>
                      <td className="py-2 px-3 text-gray-400 text-xs">{r.usage_count || 0}</td>
                      <td className="py-2 px-3 text-gray-400 text-xs whitespace-nowrap" title={r.created_at ? `录入于 ${String(r.created_at).slice(0, 16).replace('T', ' ')}` : ''}>
                        {r.created_by_name || '—'}{r.created_at ? ` ${new Date(r.created_at).getMonth() + 1}/${new Date(r.created_at).getDate()}` : ''}
                      </td>
                      <td className="py-2 px-3 whitespace-nowrap">
                        <div className="flex gap-2">
                          <button onClick={() => setDetailMat(r)} className="text-xs text-emerald-600 hover:underline">供应链</button>
                          {canManage && <>
                            <button onClick={() => openEdit(r)} className="text-xs text-indigo-600 hover:underline">编辑</button>
                            <button onClick={() => archive(r)} className="text-xs text-gray-400 hover:text-amber-600 hover:underline">归档</button>
                            <button onClick={() => remove(r)} className="text-xs text-gray-400 hover:text-red-500 hover:underline">删除</button>
                          </>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {tab === 'pending' && (
        <div>
          <p className="text-xs text-gray-500 mb-3">订单录入时建的「临时物料」(只服务来源订单)。查重后转正 → 全公司可复用。仅理单/采购/管理员可转正。</p>
          {pending.length === 0 ? (
            <div className="text-center py-12 text-gray-400 text-sm">暂无待转正的临时物料。</div>
          ) : (
            <div className="space-y-2">
              {pending.map(r => (
                <div key={r.id} className="bg-white rounded-xl border border-gray-200 p-4">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <span className="font-medium text-gray-900">{r.material_name}</span>
                      <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">{catLabel(r.category)}</span>
                      <span className="ml-2 text-xs text-gray-400">
                        来源 {r.orders?.order_no || '?'} · {r.orders?.customer_name || ''} · 单耗 {r.default_consumption ?? '—'} {r.default_unit || ''} {r.default_supplier_name ? '· ' + r.default_supplier_name : ''}
                      </span>
                    </div>
                    {canManage && (
                      <button onClick={() => promote(r.id)} disabled={promoting === r.id}
                        className="shrink-0 px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700 disabled:opacity-50">
                        {promoting === r.id ? '转正中...' : '转为正式'}
                      </button>
                    )}
                  </div>
                  {promoteSimilar && promoteSimilar.id === r.id && (
                    <div className="mt-2 text-xs bg-amber-50 border border-amber-200 rounded-lg p-2">
                      <p className="text-amber-700 font-medium">⚠️ 可能已有类似物料:</p>
                      <ul className="text-amber-700 mt-1 space-y-0.5">
                        {promoteSimilar.similar.map((s: any) => <li key={s.id}>· {s.material_name} {s.material_code ? `(${s.material_code})` : ''} {s.specification || ''}</li>)}
                      </ul>
                      <button onClick={() => promote(r.id, true)} className="mt-2 text-amber-800 underline">仍要转正</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 新建/编辑表单 */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30" onClick={() => setShowForm(false)} />
          <div className="relative bg-white rounded-2xl border border-gray-200 shadow-xl p-6 w-full max-w-lg">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">{editId ? '编辑物料' : '新建物料'}</h2>
            <div className="grid grid-cols-2 gap-3">
              <label className="col-span-2 text-xs text-gray-600">编号(系统自动生成,不可填)
                <input readOnly value={editId ? (editingCode || '—') : '保存后自动生成（如 FAB-0001）'}
                  className="mt-1 w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-400 cursor-not-allowed" /></label>
              <label className="col-span-2 text-xs text-gray-600">物料名称 *
                <input value={form.material_name} onChange={e => setForm(f => ({ ...f, material_name: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
              <label className="text-xs text-gray-600">类别 *
                <select value={catMode === 'custom' ? '__custom__' : form.category}
                  onChange={e => {
                    if (e.target.value === '__custom__') { setCatMode('custom'); setForm(f => ({ ...f, category: '' })); }
                    else { setCatMode('preset'); setForm(f => ({ ...f, category: e.target.value })); }
                  }}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white">
                  {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                  <option value="__custom__">➕ 添加新类别…</option>
                </select>
                {catMode === 'custom' && (
                  <input value={form.category ?? ''} autoFocus placeholder="输入新类别名(如 里布)"
                    onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-indigo-300 px-3 py-2 text-sm" />
                )}</label>
              <label className="text-xs text-gray-600">单位 *
                <select value={unitMode === 'custom' ? '__custom__' : (form.default_unit || '')}
                  onChange={e => {
                    if (e.target.value === '__custom__') { setUnitMode('custom'); setForm(f => ({ ...f, default_unit: '' })); }
                    else { setUnitMode('preset'); setForm(f => ({ ...f, default_unit: e.target.value })); }
                  }}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white">
                  <option value="">— 选择单位 —</option>
                  {UNIT_SUGGEST.map(u => <option key={u} value={u}>{u}</option>)}
                  <option value="__custom__">➕ 添加新单位…</option>
                </select>
                {unitMode === 'custom' && (
                  <input value={form.default_unit ?? ''} autoFocus placeholder="输入新单位(如 匹)"
                    onChange={e => setForm(f => ({ ...f, default_unit: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-indigo-300 px-3 py-2 text-sm" />
                )}</label>
              <label className="text-xs text-gray-600">参考价（不含税净价）
                <input type="number" step="any" value={form.reference_price ?? ''} placeholder="单价" onChange={e => setForm(f => ({ ...f, reference_price: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
              <label className="text-xs text-gray-600">默认交期(工作日)
                <input type="number" value={form.default_lead_days ?? ''} onChange={e => setForm(f => ({ ...f, default_lead_days: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
              <label className="col-span-2 text-xs text-gray-600">规格(克重/门幅/成分)— 同名布料靠规格区分变体,如「仿锦直贡呢拉毛」260g / 270g / 275g 各一条
                <input value={form.specification ?? ''} placeholder="如 260g 门幅150cm" onChange={e => setForm(f => ({ ...f, specification: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
            </div>

            {!editId && similar && similar.length > 0 && (
              <div className="mt-3 text-xs bg-amber-50 border border-amber-200 rounded-lg p-3">
                <p className="text-amber-800 font-medium mb-1.5">⚠ 可能已有:</p>
                <ul className="space-y-1">
                  {similar.map(s => (
                    <li key={s.id} className="flex items-center gap-2 text-amber-800">
                      <span className="font-mono text-amber-600 shrink-0">{s.material_code || '—'}</span>
                      <span className="font-medium shrink-0">{s.material_name}</span>
                      <span className="text-amber-600 truncate">{s.specification || ''}</span>
                    </li>
                  ))}
                </ul>
                <div className="flex gap-2 mt-2.5">
                  <button onClick={() => save(true)} disabled={saving} className="px-3 py-1.5 rounded-lg bg-amber-600 text-white font-medium hover:bg-amber-700 disabled:opacity-50">确认不同,继续创建</button>
                  <button onClick={() => { setShowForm(false); setSearch(similar[0].material_name); }} className="px-3 py-1.5 rounded-lg border border-amber-300 text-amber-700 hover:bg-amber-100">使用已有</button>
                </div>
              </div>
            )}

            <div className="flex gap-2 mt-5">
              <button onClick={() => save()} disabled={saving || !form.material_name.trim()}
                className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
                {saving ? '保存中...' : editId ? '更新' : '保存'}
              </button>
              <button onClick={() => setShowForm(false)} className="px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-500 hover:bg-gray-50">取消</button>
            </div>
          </div>
        </div>
      )}

      {/* SC-P1 供应链详情抽屉 */}
      {detailMat && (
        <MaterialDetailPanel material={detailMat} canManage={canManage} onClose={() => setDetailMat(null)} />
      )}
    </div>
  );
}
