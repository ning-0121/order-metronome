'use client';
import { useEffect, useState } from 'react';
import { getQcInspections, addQcInspection, updateQcResult, deleteQcInspection } from '@/app/actions/qc';

const TYPE_OPTIONS = [
  { value: 'mid', label: '中查' }, { value: 'final', label: '尾查' },
  { value: 'inline', label: '巡查' }, { value: 're-inspection', label: '复检' },
];
const RESULT_CONFIG: Record<string, { label: string; cls: string }> = {
  pending: { label: '待检', cls: 'bg-gray-100 text-gray-600' },
  pass: { label: '通过', cls: 'bg-green-100 text-green-700' },
  fail: { label: '不通过', cls: 'bg-red-100 text-red-700' },
  conditional: { label: '有条件通过', cls: 'bg-yellow-100 text-yellow-700' },
};

export function QcTab({ orderId, isAdmin, currentRole }: { orderId: string; isAdmin: boolean; currentRole: string }) {
  const [records, setRecords] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ inspection_type: 'mid', qty_inspected: '', qty_pass: '', qty_fail: '', aql_level: 'II', notes: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const reload = () => getQcInspections(orderId).then(({ data }) => setRecords(data || []));
  useEffect(() => { reload().then(() => setLoading(false)); }, [orderId]);

  async function handleAdd() {
    setSaving(true); setError('');
    const result = await addQcInspection(orderId, {
      inspection_type: form.inspection_type,
      qty_inspected: parseInt(form.qty_inspected) || 0,
      qty_pass: parseInt(form.qty_pass) || 0,
      qty_fail: parseInt(form.qty_fail) || 0,
      aql_level: form.aql_level, notes: form.notes || undefined,
    });
    if (result.error) setError(result.error);
    else { setShowAdd(false); setForm({ inspection_type: 'mid', qty_inspected: '', qty_pass: '', qty_fail: '', aql_level: 'II', notes: '' }); await reload(); }
    setSaving(false);
  }

  async function handleResult(id: string, result: 'pass' | 'fail' | 'conditional') {
    await updateQcResult(id, orderId, result);
    await reload();
  }

  if (loading) return <div className="text-center py-8 text-gray-400">加载中...</div>;

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <span className="text-sm text-gray-500">{records.length} 条检验记录</span>
        {!showAdd && <button onClick={() => setShowAdd(true)} className="text-sm px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700">+ 新增检验</button>}
      </div>

      {showAdd && (
        <div className="bg-indigo-50 rounded-xl p-4 mb-4 space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <select value={form.inspection_type} onChange={e => setForm(f => ({ ...f, inspection_type: e.target.value }))} className="rounded-lg border border-gray-300 px-3 py-2 text-sm">
              {TYPE_OPTIONS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            <input placeholder="抽检数量 *" type="number" value={form.qty_inspected} onChange={e => setForm(f => ({ ...f, qty_inspected: e.target.value }))} className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            <input placeholder="AQL等级" value={form.aql_level} onChange={e => setForm(f => ({ ...f, aql_level: e.target.value }))} className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <input placeholder="合格数" type="number" value={form.qty_pass} onChange={e => setForm(f => ({ ...f, qty_pass: e.target.value }))} className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            <input placeholder="不合格数" type="number" value={form.qty_fail} onChange={e => setForm(f => ({ ...f, qty_fail: e.target.value }))} className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            <input placeholder="备注" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex gap-2">
            <button onClick={handleAdd} disabled={saving || !form.qty_inspected} className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium disabled:opacity-50">保存</button>
            <button onClick={() => setShowAdd(false)} className="px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-500">取消</button>
          </div>
        </div>
      )}

      {records.length === 0 && !showAdd ? (
        <div className="text-center py-12 text-gray-400"><p>暂无 QC 检验记录</p>
          <button onClick={() => setShowAdd(true)} className="text-indigo-600 text-sm font-medium hover:underline mt-2">+ 新增检验记录</button></div>
      ) : (
        <div className="space-y-4">
          {records.map(rec => {
            const rc = RESULT_CONFIG[rec.result] || RESULT_CONFIG.pending;
            const passRate = rec.qty_inspected > 0 ? Math.round((rec.qty_pass || 0) / rec.qty_inspected * 100) : 0;
            return (
              <div key={rec.id} className="border border-gray-200 rounded-xl p-5">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <span className="font-medium text-gray-900">{TYPE_OPTIONS.find(t=>t.value===rec.inspection_type)?.label || rec.inspection_type}</span>
                    <span className="text-sm text-gray-400">{rec.inspection_date}</span>
                    <span className="text-xs text-gray-400">AQL {rec.aql_level}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${rc.cls}`}>{rc.label}</span>
                    <button onClick={() => { if (confirm('删除此检验记录？')) deleteQcInspection(rec.id, orderId).then(reload); }} className="text-xs text-red-500 hover:underline">删除</button>
                  </div>
                </div>
                <div className="grid grid-cols-4 gap-3 mb-3">
                  {[
                    { label: '抽检数', value: rec.qty_inspected, color: 'text-gray-700' },
                    { label: '合格', value: rec.qty_pass || 0, color: 'text-green-600' },
                    { label: '不合格', value: rec.qty_fail || 0, color: 'text-red-600' },
                    { label: '合格率', value: passRate + '%', color: passRate >= 90 ? 'text-green-600' : passRate >= 70 ? 'text-yellow-600' : 'text-red-600' },
                  ].map(m => (
                    <div key={m.label} className="text-center p-2 bg-gray-50 rounded-lg">
                      <div className={`text-xl font-bold ${m.color}`}>{m.value}</div>
                      <div className="text-xs text-gray-400 mt-0.5">{m.label}</div>
                    </div>
                  ))}
                </div>
                {rec.notes && <p className="text-sm text-gray-500 mb-3">{rec.notes}</p>}
                {rec.result === 'pending' && (
                  <div className="flex gap-2">
                    <button onClick={() => handleResult(rec.id, 'pass')} className="text-xs px-3 py-1.5 rounded-lg bg-green-600 text-white font-medium hover:bg-green-700">通过</button>
                    <button onClick={() => handleResult(rec.id, 'fail')} className="text-xs px-3 py-1.5 rounded-lg bg-red-600 text-white font-medium hover:bg-red-700">不通过</button>
                    <button onClick={() => handleResult(rec.id, 'conditional')} className="text-xs px-3 py-1.5 rounded-lg border border-yellow-300 text-yellow-700 font-medium hover:bg-yellow-50">有条件通过</button>
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
