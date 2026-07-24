'use client';
import { useEffect, useState } from 'react';
import {
  getProductionTransfers, addProductionTransfer, updateProductionTransfer, deleteProductionTransfer,
} from '@/app/actions/production-transfer';

// 临时调货状态:已调出(在B厂)/ 已归还A厂 / 并入B厂大货(不还,两厂结算)
const STATUS = [
  { value: 'out', label: '已调出', cls: 'bg-amber-100 text-amber-700' },
  { value: 'returned', label: '已归还', cls: 'bg-green-100 text-green-700' },
  { value: 'consumed', label: '并入B厂(不还)', cls: 'bg-blue-100 text-blue-700' },
];

const EMPTY = { from_factory: '', to_factory: '', item_desc: '', qty: '', unit: '件', reason: '', transfer_date: '', expected_return_date: '' };

export function ProductionTransferSection({ orderId }: { orderId: string }) {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ ...EMPTY });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ status: '', actual_return_date: '', notes: '' });

  const reload = () => getProductionTransfers(orderId).then(({ data }) => setRows(data || []));
  useEffect(() => { reload().then(() => setLoading(false)); }, [orderId]);

  async function handleAdd() {
    setSaving(true); setError('');
    const r = await addProductionTransfer(orderId, {
      from_factory: form.from_factory, to_factory: form.to_factory, item_desc: form.item_desc,
      qty: parseFloat(form.qty) || 0, unit: form.unit || '件',
      reason: form.reason || undefined, transfer_date: form.transfer_date || undefined,
      expected_return_date: form.expected_return_date || undefined,
    });
    if (r.error) setError(r.error);
    else { setShowAdd(false); setForm({ ...EMPTY }); await reload(); }
    setSaving(false);
  }

  async function handleUpdate(id: string) {
    setSaving(true); setError('');
    const r = await updateProductionTransfer(id, orderId, {
      status: editForm.status || undefined,
      actual_return_date: editForm.actual_return_date || undefined,
      notes: editForm.notes || undefined,
    });
    if (r.error) setError(r.error);
    else { setEditId(null); await reload(); }
    setSaving(false);
  }

  const inp = 'rounded-lg border border-gray-300 px-3 py-2 text-sm';

  return (
    <div className="mt-8 pt-6 border-t border-gray-200">
      <div className="flex justify-between items-center mb-1">
        <h3 className="text-sm font-semibold text-gray-800">🔁 临时调货(裁片 / 半成品 工厂间救急)</h3>
        {!showAdd && <button onClick={() => setShowAdd(true)} className="text-sm px-3 py-1.5 rounded-lg bg-teal-600 text-white font-medium hover:bg-teal-700">+ 新增调货</button>}
      </div>
      <p className="text-[11px] text-gray-400 mb-3">A 厂机器坏 / 产能不足时,把裁片或半成品临时挪到 B 厂救急;记调出厂 / 调入厂 / 数量,后面归还或并入 B 厂大货。</p>

      {showAdd && (
        <div className="bg-teal-50 rounded-xl p-4 mb-4 space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <input placeholder="调出厂(A)*" value={form.from_factory} onChange={e => setForm(f => ({ ...f, from_factory: e.target.value }))} className={inp} />
            <input placeholder="调入厂(B)*" value={form.to_factory} onChange={e => setForm(f => ({ ...f, to_factory: e.target.value }))} className={inp} />
            <input placeholder="调什么(如 黑色前片)*" value={form.item_desc} onChange={e => setForm(f => ({ ...f, item_desc: e.target.value }))} className={`${inp} md:col-span-2`} />
            <input placeholder="数量*" type="number" value={form.qty} onChange={e => setForm(f => ({ ...f, qty: e.target.value }))} className={inp} />
            <input placeholder="单位" value={form.unit} onChange={e => setForm(f => ({ ...f, unit: e.target.value }))} className={inp} />
            <input placeholder="原因(机器坏/赶不及…)" value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} className={`${inp} md:col-span-2`} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">调出日期</label>
              <input type="date" value={form.transfer_date} onChange={e => setForm(f => ({ ...f, transfer_date: e.target.value }))} className={`w-full ${inp}`} />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">预计归还</label>
              <input type="date" value={form.expected_return_date} onChange={e => setForm(f => ({ ...f, expected_return_date: e.target.value }))} className={`w-full ${inp}`} />
            </div>
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex gap-2">
            <button onClick={handleAdd} disabled={saving || !form.from_factory.trim() || !form.to_factory.trim() || !form.item_desc.trim() || !form.qty} className="px-4 py-2 rounded-lg bg-teal-600 text-white text-sm font-medium disabled:opacity-50">保存</button>
            <button onClick={() => { setShowAdd(false); setError(''); }} className="px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-500">取消</button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center py-6 text-gray-400 text-sm">加载中…</div>
      ) : rows.length === 0 && !showAdd ? (
        <div className="text-center py-8 text-gray-400 text-sm">暂无临时调货</div>
      ) : (
        <div className="space-y-3">
          {rows.map(t => {
            const st = STATUS.find(s => s.value === t.status) || STATUS[0];
            const isEditing = editId === t.id;
            const overdue = t.status === 'out' && t.expected_return_date && t.expected_return_date < new Date().toISOString().slice(0, 10);
            return (
              <div key={t.id} className="border border-gray-200 rounded-xl p-4">
                <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
                  <div className="flex items-center gap-2 flex-wrap text-sm">
                    <span className="font-medium text-gray-900">{t.from_factory}</span>
                    <span className="text-gray-400">→</span>
                    <span className="font-medium text-gray-900">{t.to_factory}</span>
                    <span className="text-gray-500">· {t.item_desc}</span>
                    <span className="font-semibold text-gray-800">{Number(t.qty).toLocaleString('zh-CN')}{t.unit || '件'}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${st.cls}`}>{st.label}</span>
                    {overdue && <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-red-100 text-red-700">已逾期未还</span>}
                    <button onClick={() => deleteProductionTransfer(t.id, orderId).then(reload)} className="text-xs text-red-500 hover:underline">删除</button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                  {t.reason && <span>原因:<strong className="text-gray-700">{t.reason}</strong></span>}
                  {t.transfer_date && <span>调出:<strong className="text-gray-700">{t.transfer_date}</strong></span>}
                  {t.expected_return_date && <span>预计归还:<strong className="text-gray-700">{t.expected_return_date}</strong></span>}
                  {t.actual_return_date && <span>实际归还:<strong className="text-green-700">{t.actual_return_date}</strong></span>}
                  {t.notes && <span>备注:<strong className="text-gray-700">{t.notes}</strong></span>}
                </div>
                {!isEditing ? (
                  <button onClick={() => { setEditId(t.id); setEditForm({ status: t.status, actual_return_date: t.actual_return_date || '', notes: t.notes || '' }); setError(''); }}
                    className="mt-2 text-xs text-teal-600 font-medium hover:underline">更新状态 / 归还</button>
                ) : (
                  <div className="bg-gray-50 rounded-lg p-3 mt-2 space-y-2">
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                      <select value={editForm.status} onChange={e => setEditForm(f => ({ ...f, status: e.target.value }))} className="rounded border border-gray-300 px-2 py-1.5 text-sm">
                        {STATUS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                      </select>
                      <input type="date" placeholder="实际归还日" value={editForm.actual_return_date} onChange={e => setEditForm(f => ({ ...f, actual_return_date: e.target.value }))} className="rounded border border-gray-300 px-2 py-1.5 text-sm" />
                      <input placeholder="备注" value={editForm.notes} onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))} className="rounded border border-gray-300 px-2 py-1.5 text-sm" />
                    </div>
                    <p className="text-[11px] text-gray-400">选「已归还」不填日期 → 默认今天。「并入B厂」= 这批不还了,两厂另行结算。</p>
                    {error && <p className="text-xs text-red-600">{error}</p>}
                    <div className="flex gap-2">
                      <button onClick={() => handleUpdate(t.id)} disabled={saving} className="px-3 py-1.5 rounded-lg bg-teal-600 text-white text-xs font-medium disabled:opacity-50">保存</button>
                      <button onClick={() => { setEditId(null); setError(''); }} className="px-3 py-1.5 rounded-lg border border-gray-200 text-xs text-gray-500">取消</button>
                    </div>
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
