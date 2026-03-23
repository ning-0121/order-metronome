'use client';
import { useEffect, useState } from 'react';
import { getPackingLists, addPackingList, addPackingLine, deletePackingLine, confirmPackingList } from '@/app/actions/packing';

const STATUS_CONFIG: Record<string, { label: string; cls: string }> = {
  draft: { label: '草稿', cls: 'bg-gray-100 text-gray-600' },
  confirmed: { label: '已确认', cls: 'bg-blue-100 text-blue-700' },
  locked: { label: '已锁定', cls: 'bg-green-100 text-green-700' },
};

export function PackingTab({ orderId, isAdmin }: { orderId: string; isAdmin: boolean }) {
  const [lists, setLists] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [addingLine, setAddingLine] = useState<string | null>(null);
  const [lineForm, setLineForm] = useState({ style_no: '', color: '', carton_count: '', qty_per_carton: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const reload = () => getPackingLists(orderId).then(({ data }) => setLists(data || []));
  useEffect(() => { reload().then(() => setLoading(false)); }, [orderId]);

  async function handleAddList() {
    setSaving(true);
    const result = await addPackingList(orderId);
    if (result.error) setError(result.error);
    else await reload();
    setSaving(false);
  }

  async function handleAddLine(plId: string) {
    setSaving(true); setError('');
    const result = await addPackingLine(plId, orderId, {
      style_no: lineForm.style_no || undefined,
      color: lineForm.color || undefined,
      carton_count: parseInt(lineForm.carton_count) || 0,
      qty_per_carton: parseInt(lineForm.qty_per_carton) || 0,
    });
    if (result.error) setError(result.error);
    else { setAddingLine(null); setLineForm({ style_no: '', color: '', carton_count: '', qty_per_carton: '' }); await reload(); }
    setSaving(false);
  }

  async function handleDeleteLine(lineId: string, plId: string) {
    if (!confirm('删除此行？')) return;
    await deletePackingLine(lineId, plId, orderId);
    await reload();
  }

  async function handleConfirm(plId: string) {
    if (!confirm('确认此装箱单？确认后不可修改。')) return;
    const result = await confirmPackingList(plId, orderId);
    if (result.error) setError(result.error);
    else await reload();
  }

  if (loading) return <div className="text-center py-8 text-gray-400">加载中...</div>;

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <span className="text-sm text-gray-500">{lists.length} 个装箱单</span>
        <button onClick={handleAddList} disabled={saving} className="text-sm px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50">+ 新增装箱单</button>
      </div>

      {error && <p className="text-xs text-red-600 mb-3">{error}</p>}

      {lists.length === 0 ? (
        <div className="text-center py-12 text-gray-400"><p>暂无装箱单</p></div>
      ) : (
        <div className="space-y-6">
          {lists.map(pl => {
            const st = STATUS_CONFIG[pl.status] || STATUS_CONFIG.draft;
            const isDraft = pl.status === 'draft';
            return (
              <div key={pl.id} className="border border-gray-200 rounded-xl overflow-hidden">
                <div className="flex items-center justify-between px-5 py-4 bg-gray-50 border-b border-gray-200">
                  <div className="flex items-center gap-3">
                    <span className="font-medium text-gray-900">{pl.pl_number}</span>
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${st.cls}`}>{st.label}</span>
                  </div>
                  <div className="flex items-center gap-4 text-sm text-gray-500">
                    <span>总箱数：<strong className="text-gray-900">{pl.total_cartons || 0}</strong></span>
                    <span>总件数：<strong className="text-gray-900">{pl.total_qty || 0}</strong></span>
                    {isDraft && <button onClick={() => handleConfirm(pl.id)} className="text-xs px-3 py-1 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700">确认</button>}
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="border-b border-gray-100">
                      {['款号', '颜色', '箱数', '每箱件数', '总件数', ...(isDraft ? ['操作'] : [])].map(h => (
                        <th key={h} className="py-2 px-4 text-gray-500 font-medium text-left">{h}</th>
                      ))}
                    </tr></thead>
                    <tbody>
                      {(pl.packing_list_lines || []).map((line: any) => (
                        <tr key={line.id} className="border-b border-gray-50 hover:bg-gray-50">
                          <td className="py-2 px-4 text-gray-700">{line.style_no || '—'}</td>
                          <td className="py-2 px-4 text-gray-700">{line.color || '—'}</td>
                          <td className="py-2 px-4 text-gray-700">{line.carton_count}</td>
                          <td className="py-2 px-4 text-gray-700">{line.qty_per_carton}</td>
                          <td className="py-2 px-4 font-medium text-gray-900">{line.total_qty}</td>
                          {isDraft && <td className="py-2 px-4"><button onClick={() => handleDeleteLine(line.id, pl.id)} className="text-xs text-red-500 hover:underline">删除</button></td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {isDraft && (
                  <div className="px-5 py-3 border-t border-gray-100">
                    {addingLine === pl.id ? (
                      <div className="flex gap-2 items-end">
                        <input placeholder="款号" value={lineForm.style_no} onChange={e => setLineForm(f => ({ ...f, style_no: e.target.value }))} className="rounded border border-gray-300 px-2 py-1.5 text-sm w-24" />
                        <input placeholder="颜色" value={lineForm.color} onChange={e => setLineForm(f => ({ ...f, color: e.target.value }))} className="rounded border border-gray-300 px-2 py-1.5 text-sm w-24" />
                        <input placeholder="箱数 *" type="number" value={lineForm.carton_count} onChange={e => setLineForm(f => ({ ...f, carton_count: e.target.value }))} className="rounded border border-gray-300 px-2 py-1.5 text-sm w-20" />
                        <input placeholder="每箱件数 *" type="number" value={lineForm.qty_per_carton} onChange={e => setLineForm(f => ({ ...f, qty_per_carton: e.target.value }))} className="rounded border border-gray-300 px-2 py-1.5 text-sm w-24" />
                        <button onClick={() => handleAddLine(pl.id)} disabled={saving || !lineForm.carton_count || !lineForm.qty_per_carton} className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-medium disabled:opacity-50">保存</button>
                        <button onClick={() => setAddingLine(null)} className="px-3 py-1.5 rounded-lg border border-gray-200 text-xs text-gray-500">取消</button>
                      </div>
                    ) : (
                      <button onClick={() => { setAddingLine(pl.id); setLineForm({ style_no: '', color: '', carton_count: '', qty_per_carton: '' }); }} className="text-xs text-indigo-600 font-medium hover:underline">+ 新增行</button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
