'use client';
import { useEffect, useState } from 'react';
import { getBomItems, addBomItem, updateBomItem, deleteBomItem } from '@/app/actions/bom';

const TYPES = [
  { value: 'fabric', label: '面料' }, { value: 'trim', label: '辅料' },
  { value: 'lining', label: '里料' }, { value: 'label', label: '标签' },
  { value: 'packing', label: '包装' }, { value: 'other', label: '其他' },
];

const emptyForm = { material_name: '', material_type: 'fabric', material_code: '', qty_per_piece: '', total_qty: '', unit: 'meter', supplier: '' };

export function BomTab({ orderId }: { orderId: string }) {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const reload = () => getBomItems(orderId).then(({ data }) => setItems(data || []));
  useEffect(() => { reload().then(() => setLoading(false)); }, [orderId]);

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  async function handleSave() {
    setSaving(true); setError('');
    const payload = {
      material_name: form.material_name, material_type: form.material_type,
      material_code: form.material_code || undefined,
      qty_per_piece: form.qty_per_piece ? parseFloat(form.qty_per_piece) : undefined,
      total_qty: form.total_qty ? parseFloat(form.total_qty) : undefined,
      unit: form.unit, supplier: form.supplier || undefined,
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

  function startEdit(item: any) {
    setEditId(item.id);
    setForm({
      material_name: item.material_name || '', material_type: item.material_type || 'other',
      material_code: item.material_code || '', qty_per_piece: item.qty_per_piece?.toString() || '',
      total_qty: item.total_qty?.toString() || '', unit: item.unit || 'meter', supplier: item.supplier || '',
    });
    setShowAdd(true);
  }

  if (loading) return <div className="text-center py-8 text-gray-400">加载中...</div>;

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

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <span className="text-sm text-gray-500">{items.length} 条物料记录</span>
        {!showAdd && (
          <button onClick={() => { setShowAdd(true); setEditId(null); setForm(emptyForm); }}
            className="text-sm px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700">+ 新增物料</button>
        )}
      </div>
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
              {['物料代码','物料名称','类型','单件用量','总需','单位','供应商','操作'].map(h => (
                <th key={h} className="py-2 px-3 text-gray-500 font-medium text-left">{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {items.map(item => (
                <tr key={item.id} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="py-2 px-3 font-mono text-xs text-gray-500">{item.material_code || '—'}</td>
                  <td className="py-2 px-3 font-medium text-gray-900">{item.material_name}</td>
                  <td className="py-2 px-3"><span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">{TYPES.find(t=>t.value===item.material_type)?.label || item.material_type}</span></td>
                  <td className="py-2 px-3 text-gray-700">{item.qty_per_piece ?? '—'}</td>
                  <td className="py-2 px-3 font-medium text-gray-900">{item.total_qty ?? '—'}</td>
                  <td className="py-2 px-3 text-gray-600">{item.unit}</td>
                  <td className="py-2 px-3 text-gray-500">{item.supplier || '—'}</td>
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
