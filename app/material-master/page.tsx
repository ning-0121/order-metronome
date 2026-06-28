'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  listMaterialMaster, createMaterialMaster, updateMaterialMaster, archiveMaterialMaster,
  listPendingPromotion, promoteTemporaryMaterial, canManageMaster, type MasterInput,
} from '@/app/actions/material-master';

const CATEGORIES: { value: string; label: string }[] = [
  { value: 'fabric', label: '面料' }, { value: 'trim', label: '辅料' },
  { value: 'packing', label: '包装' }, { value: 'print', label: '印花' },
  { value: 'washing', label: '洗水' }, { value: 'embroidery', label: '绣花' },
  { value: 'service', label: '服务' }, { value: 'other', label: '其他' },
];
const catLabel = (c: string) => CATEGORIES.find(x => x.value === c)?.label || c;
const emptyForm: MasterInput = { material_name: '', category: 'fabric', default_unit: '', default_consumption: '', default_supplier_name: '', default_lead_days: '', specification: '' };

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
  const [form, setForm] = useState<MasterInput>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [similar, setSimilar] = useState<any[] | null>(null);

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

  function openNew() { setEditId(null); setForm(emptyForm); setSimilar(null); setShowForm(true); }
  function openEdit(r: any) {
    setEditId(r.id);
    setForm({ material_name: r.material_name || '', category: r.category || 'other', default_unit: r.default_unit || '', default_consumption: r.default_consumption ?? '', default_supplier_name: r.default_supplier_name || '', default_lead_days: r.default_lead_days ?? '', specification: r.specification || '' });
    setSimilar(null); setShowForm(true);
  }

  async function save(force = false) {
    setSaving(true); setMsg(''); setSimilar(null);
    const res = editId
      ? await updateMaterialMaster(editId, form)
      : await createMaterialMaster(form, { force });
    setSaving(false);
    if ((res as any).similar) { setSimilar((res as any).similar); return; }  // 相似提示,不阻断
    if (res.error) { setMsg('保存失败：' + res.error); return; }
    setShowForm(false); setMsg(editId ? '✅ 已更新' : `✅ 已新建（${(res as any).data?.material_code || ''}）`);
    loadLib();
  }

  async function archive(r: any) {
    if (!confirm(`归档物料「${r.material_name}」？归档后不再出现在搜索/录入中（数据保留）。`)) return;
    const res = await archiveMaterialMaster(r.id);
    if (res.error) { alert(res.error); return; }
    loadLib();
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
          </div>

          {loading ? <div className="text-center py-10 text-gray-400">加载中...</div> : rows.length === 0 ? (
            <div className="text-center py-12 text-gray-400 text-sm">
              暂无物料主数据。点「+ 新建物料」录入,或在订单录入原辅料时新建物料会沉淀到这里。
            </div>
          ) : (
            <div className="overflow-x-auto bg-white rounded-xl border border-gray-200">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-gray-100 text-left text-gray-500">
                  {['编码', '名称', '类别', '默认单耗', '单位', '默认供应商', '交期', '规格', '用过', ''].map(h => (
                    <th key={h} className="py-2 px-3 font-medium whitespace-nowrap">{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id} className="border-b border-gray-50 hover:bg-gray-50">
                      <td className="py-2 px-3 font-mono text-xs text-gray-500">{r.material_code || '—'}</td>
                      <td className="py-2 px-3 font-medium text-gray-900">{r.material_name}</td>
                      <td className="py-2 px-3"><span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">{catLabel(r.category)}</span></td>
                      <td className="py-2 px-3 text-gray-700">{r.default_consumption ?? '—'}</td>
                      <td className="py-2 px-3 text-gray-600">{r.default_unit || '—'}</td>
                      <td className="py-2 px-3 text-gray-600">{r.default_supplier_name || '—'}</td>
                      <td className="py-2 px-3 text-gray-600">{r.default_lead_days ?? '—'}</td>
                      <td className="py-2 px-3 text-gray-500 max-w-[160px] truncate">{r.specification || '—'}</td>
                      <td className="py-2 px-3 text-gray-400 text-xs">{r.usage_count || 0}</td>
                      <td className="py-2 px-3 whitespace-nowrap">
                        {canManage ? (
                          <div className="flex gap-2">
                            <button onClick={() => openEdit(r)} className="text-xs text-indigo-600 hover:underline">编辑</button>
                            <button onClick={() => archive(r)} className="text-xs text-gray-400 hover:text-red-500 hover:underline">归档</button>
                          </div>
                        ) : <span className="text-xs text-gray-300">—</span>}
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
                  {promoteSimilar?.id === r.id && (
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
              <label className="col-span-2 text-xs text-gray-600">物料名称 *
                <input value={form.material_name} onChange={e => setForm(f => ({ ...f, material_name: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
              <label className="text-xs text-gray-600">类别 *
                <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                  {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select></label>
              <label className="text-xs text-gray-600">默认单位
                <input value={form.default_unit ?? ''} placeholder="kg/pcs/m" onChange={e => setForm(f => ({ ...f, default_unit: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
              <label className="text-xs text-gray-600">默认单耗
                <input type="number" step="any" value={form.default_consumption ?? ''} onChange={e => setForm(f => ({ ...f, default_consumption: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
              <label className="text-xs text-gray-600">默认交期(工作日)
                <input type="number" value={form.default_lead_days ?? ''} onChange={e => setForm(f => ({ ...f, default_lead_days: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
              <label className="col-span-2 text-xs text-gray-600">默认供应商
                <input value={form.default_supplier_name ?? ''} onChange={e => setForm(f => ({ ...f, default_supplier_name: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
              <label className="col-span-2 text-xs text-gray-600">规格(成分/克重/纱支)
                <input value={form.specification ?? ''} onChange={e => setForm(f => ({ ...f, specification: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
            </div>

            {similar && (
              <div className="mt-3 text-xs bg-amber-50 border border-amber-200 rounded-lg p-2">
                <p className="text-amber-700 font-medium">⚠️ 可能已有类似物料(不强制阻止):</p>
                <ul className="text-amber-700 mt-1 space-y-0.5">
                  {similar.map(s => <li key={s.id}>· {s.material_name} {s.material_code ? `(${s.material_code})` : ''} {s.specification || ''}</li>)}
                </ul>
                <button onClick={() => save(true)} className="mt-2 text-amber-800 underline">仍要新建</button>
              </div>
            )}

            <div className="flex gap-2 mt-5">
              <button onClick={() => save(false)} disabled={saving || !form.material_name.trim()}
                className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
                {saving ? '保存中...' : editId ? '更新' : '保存'}
              </button>
              <button onClick={() => setShowForm(false)} className="px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-500 hover:bg-gray-50">取消</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
