'use client';

/**
 * 客户标准辅料库维护面板（客户卡片内折叠块）。
 * 库=母版：在此维护客户×品牌标准辅料，建单时在订单 BOM 页一键带入。
 * 「删除」走软删除（active=false），保留历史版本。
 */

import { useState } from 'react';
import {
  listTrimLibrary,
  addTrimItem,
  updateTrimItem,
  setTrimItemActive,
  type TrimLibraryItem,
  type TrimItemInput,
} from '@/app/actions/customer-trim-library';

const TYPES = [
  { value: 'fabric', label: '面料' }, { value: 'trim', label: '辅料' },
  { value: 'lining', label: '里料' }, { value: 'label', label: '标签' },
  { value: 'packing', label: '包装' }, { value: 'other', label: '其他' },
];
const typeLabel = (v: string) => TYPES.find(t => t.value === v)?.label || v;

const emptyForm = {
  brand: '', material_name: '', material_type: 'label',
  placement: '', color: '', qty_per_piece: '', unit: '', supplier: '', spec: '', notes: '',
};
type FormState = typeof emptyForm;

function toInput(f: FormState): TrimItemInput {
  return {
    brand: f.brand || null,
    material_name: f.material_name,
    material_type: f.material_type,
    placement: f.placement || null,
    color: f.color || null,
    qty_per_piece: f.qty_per_piece ? parseFloat(f.qty_per_piece) : null,
    unit: f.unit || null,
    supplier: f.supplier || null,
    spec: f.spec || null,
    notes: f.notes || null,
  };
}

export function CustomerTrimLibraryPanel({ customerName }: { customerName: string }) {
  const [items, setItems] = useState<TrimLibraryItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = (k: keyof FormState, v: string) => setForm(f => ({ ...f, [k]: v }));

  async function load() {
    setLoading(true);
    const { data } = await listTrimLibrary(customerName);
    setItems(data || []);
    setLoading(false);
  }

  // 折叠块展开时首次加载
  function onToggle(e: React.SyntheticEvent<HTMLDetailsElement>) {
    if (e.currentTarget.open && items === null) load();
  }

  function startAdd() {
    setEditId(null); setForm(emptyForm); setError(''); setShowForm(true);
  }
  function startEdit(item: TrimLibraryItem) {
    setEditId(item.id);
    setForm({
      brand: item.brand || '', material_name: item.material_name, material_type: item.material_type,
      placement: item.placement || '', color: item.color || '',
      qty_per_piece: item.qty_per_piece?.toString() || '', unit: item.unit || '',
      supplier: item.supplier || '', spec: item.spec || '', notes: item.notes || '',
    });
    setError(''); setShowForm(true);
  }

  async function handleSave() {
    if (!form.material_name.trim()) return;
    setSaving(true); setError('');
    const res = editId
      ? await updateTrimItem(editId, toInput(form))
      : await addTrimItem(customerName, toInput(form));
    if (res.error) { setError(res.error); setSaving(false); return; }
    setShowForm(false); setEditId(null); setForm(emptyForm); setSaving(false);
    await load();
  }

  async function handleDeactivate(id: string) {
    if (!confirm('停用此标准辅料？（保留历史，可日后新增同名版本）')) return;
    await setTrimItemActive(id, false);
    await load();
  }

  const count = items?.length ?? 0;

  return (
    <details className="group" onToggle={onToggle}>
      <summary className="text-xs font-medium text-gray-500 cursor-pointer hover:text-gray-700 select-none">
        🧵 客户标准辅料库{count > 0 ? `（${count}）` : ''}
      </summary>
      <div className="mt-2 rounded-lg bg-gray-50 p-3">
        {loading && items === null ? (
          <div className="text-xs text-gray-400 py-2">加载中…</div>
        ) : (
          <>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-gray-400">建单后可在订单 BOM 页「📥 从客户标准库带入」一键复制</span>
              {!showForm && (
                <button onClick={startAdd}
                  className="text-xs px-2 py-1 rounded bg-indigo-600 text-white font-medium hover:bg-indigo-700">+ 新增标准辅料</button>
              )}
            </div>

            {showForm && (
              <div className="bg-white rounded-lg border border-indigo-200 p-3 mb-3 space-y-2">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  <input placeholder="品牌（空=通用）" value={form.brand} onChange={e => set('brand', e.target.value)}
                    className="rounded border border-gray-300 px-2 py-1 text-xs" />
                  <input placeholder="物料名称 *" value={form.material_name} onChange={e => set('material_name', e.target.value)}
                    className="rounded border border-gray-300 px-2 py-1 text-xs" />
                  <select value={form.material_type} onChange={e => set('material_type', e.target.value)}
                    className="rounded border border-gray-300 px-2 py-1 text-xs">
                    {TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                  <input placeholder="部位 placement" value={form.placement} onChange={e => set('placement', e.target.value)}
                    className="rounded border border-gray-300 px-2 py-1 text-xs" />
                  <input placeholder="颜色 color" value={form.color} onChange={e => set('color', e.target.value)}
                    className="rounded border border-gray-300 px-2 py-1 text-xs" />
                  <input placeholder="单件用量" type="number" step="0.0001" value={form.qty_per_piece} onChange={e => set('qty_per_piece', e.target.value)}
                    className="rounded border border-gray-300 px-2 py-1 text-xs" />
                  <input placeholder="单位" value={form.unit} onChange={e => set('unit', e.target.value)}
                    className="rounded border border-gray-300 px-2 py-1 text-xs" />
                  <input placeholder="供应商" value={form.supplier} onChange={e => set('supplier', e.target.value)}
                    className="rounded border border-gray-300 px-2 py-1 text-xs" />
                  <input placeholder="规格 spec" value={form.spec} onChange={e => set('spec', e.target.value)}
                    className="rounded border border-gray-300 px-2 py-1 text-xs md:col-span-2" />
                  <input placeholder="备注 notes" value={form.notes} onChange={e => set('notes', e.target.value)}
                    className="rounded border border-gray-300 px-2 py-1 text-xs md:col-span-2" />
                </div>
                {error && <p className="text-xs text-red-600">{error}</p>}
                <div className="flex gap-2">
                  <button onClick={handleSave} disabled={saving || !form.material_name.trim()}
                    className="px-3 py-1 rounded bg-indigo-600 text-white text-xs font-medium hover:bg-indigo-700 disabled:opacity-50">
                    {saving ? '保存中…' : editId ? '更新' : '保存'}
                  </button>
                  <button onClick={() => { setShowForm(false); setEditId(null); setForm(emptyForm); setError(''); }}
                    className="px-3 py-1 rounded border border-gray-200 text-xs text-gray-500 hover:bg-gray-50">取消</button>
                </div>
              </div>
            )}

            {count === 0 && !showForm ? (
              <p className="text-xs text-gray-400 py-2">暂无标准辅料，点击「+ 新增标准辅料」建立母版。</p>
            ) : count > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="border-b border-gray-200 text-gray-400">
                    {['品牌', '物料', '类型', '部位', '颜色', '单件量', '单位', '供应商', '规格', '操作'].map(h => (
                      <th key={h} className="py-1 px-2 text-left font-medium whitespace-nowrap">{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {items!.map(it => (
                      <tr key={it.id} className="border-b border-gray-100 hover:bg-white">
                        <td className="py-1 px-2 text-gray-500">{it.brand || <span className="text-gray-300">通用</span>}</td>
                        <td className="py-1 px-2 font-medium text-gray-900">{it.material_name}</td>
                        <td className="py-1 px-2"><span className="px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700">{typeLabel(it.material_type)}</span></td>
                        <td className="py-1 px-2 text-gray-600">{it.placement || '—'}</td>
                        <td className="py-1 px-2 text-gray-600">{it.color || '—'}</td>
                        <td className="py-1 px-2 text-gray-600">{it.qty_per_piece ?? '—'}</td>
                        <td className="py-1 px-2 text-gray-600">{it.unit || '—'}</td>
                        <td className="py-1 px-2 text-gray-500">{it.supplier || '—'}</td>
                        <td className="py-1 px-2 text-gray-500">{it.spec || '—'}</td>
                        <td className="py-1 px-2 whitespace-nowrap">
                          <button onClick={() => startEdit(it)} className="text-indigo-600 hover:underline mr-2">编辑</button>
                          <button onClick={() => handleDeactivate(it.id)} className="text-red-500 hover:underline">停用</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </details>
  );
}
