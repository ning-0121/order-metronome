'use client';
import { useEffect, useState } from 'react';
import { getOutsourceJobs, addOutsourceJob, updateOutsourceJob, deleteOutsourceJob } from '@/app/actions/outsource';

const JOB_TYPES = [
  { value: 'sewing', label: '车缝' }, { value: 'embroidery', label: '绣花' },
  { value: 'printing', label: '印花' }, { value: 'washing', label: '洗水' }, { value: 'other', label: '其他' },
];
const STATUS_OPTIONS = [
  { value: 'pending', label: '待发出', cls: 'bg-gray-100 text-gray-600' },
  { value: 'in_progress', label: '进行中', cls: 'bg-blue-100 text-blue-700' },
  { value: 'returned', label: '已回收', cls: 'bg-green-100 text-green-700' },
  { value: 'closed', label: '已关闭', cls: 'bg-gray-100 text-gray-500' },
  { value: 'exception', label: '异常', cls: 'bg-red-100 text-red-700' },
];

export function OutsourceTab({ orderId, isAdmin }: { orderId: string; isAdmin: boolean }) {
  const [jobs, setJobs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ factory_name: '', job_type: 'sewing', qty_sent: '', expected_return_date: '', expected_workers: '', expected_start_date: '', expected_end_date: '' });
  const [editForm, setEditForm] = useState({ qty_returned: '', qty_pass: '', qty_defect: '', status: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const reload = () => getOutsourceJobs(orderId).then(({ data }) => setJobs(data || []));
  useEffect(() => { reload().then(() => setLoading(false)); }, [orderId]);

  async function handleAdd() {
    setSaving(true); setError('');
    const result = await addOutsourceJob(orderId, {
      factory_name: form.factory_name, job_type: form.job_type,
      qty_sent: parseInt(form.qty_sent) || 0,
      expected_return_date: form.expected_return_date || undefined,
      expected_workers: form.expected_workers ? parseInt(form.expected_workers) : undefined,
      expected_start_date: form.expected_start_date || undefined,
      expected_end_date: form.expected_end_date || undefined,
    });
    if (result.error) setError(result.error);
    else { setShowAdd(false); setForm({ factory_name: '', job_type: 'sewing', qty_sent: '', expected_return_date: '', expected_workers: '', expected_start_date: '', expected_end_date: '' }); await reload(); }
    setSaving(false);
  }

  async function handleUpdate(id: string) {
    setSaving(true); setError('');
    const result = await updateOutsourceJob(id, orderId, {
      qty_returned: editForm.qty_returned ? parseInt(editForm.qty_returned) : undefined,
      qty_pass: editForm.qty_pass ? parseInt(editForm.qty_pass) : undefined,
      qty_defect: editForm.qty_defect ? parseInt(editForm.qty_defect) : undefined,
      status: editForm.status || undefined,
      notes: editForm.notes || undefined,
    });
    if (result.error) setError(result.error);
    else { setEditId(null); await reload(); }
    setSaving(false);
  }

  if (loading) return <div className="text-center py-8 text-gray-400">加载中...</div>;

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <span className="text-sm text-gray-500">{jobs.length} 个外发任务</span>
        {!showAdd && <button onClick={() => setShowAdd(true)} className="text-sm px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700">+ 新增外发</button>}
      </div>

      {showAdd && (
        <div className="bg-indigo-50 rounded-xl p-4 mb-4 space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <input placeholder="工厂名称 *" value={form.factory_name} onChange={e => setForm(f => ({ ...f, factory_name: e.target.value }))} className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            <select value={form.job_type} onChange={e => setForm(f => ({ ...f, job_type: e.target.value }))} className="rounded-lg border border-gray-300 px-3 py-2 text-sm">
              {JOB_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            <input placeholder="发出数量 *" type="number" value={form.qty_sent} onChange={e => setForm(f => ({ ...f, qty_sent: e.target.value }))} className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            <input placeholder="预计上线人数" type="number" value={form.expected_workers} onChange={e => setForm(f => ({ ...f, expected_workers: e.target.value }))} className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">预计上线时间</label>
              <input type="date" value={form.expected_start_date} onChange={e => setForm(f => ({ ...f, expected_start_date: e.target.value }))} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">预计下线时间</label>
              <input type="date" value={form.expected_end_date} onChange={e => setForm(f => ({ ...f, expected_end_date: e.target.value }))} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">预计回厂日</label>
              <input type="date" value={form.expected_return_date} onChange={e => setForm(f => ({ ...f, expected_return_date: e.target.value }))} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex gap-2">
            <button onClick={handleAdd} disabled={saving || !form.factory_name.trim() || !form.qty_sent} className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium disabled:opacity-50">保存</button>
            <button onClick={() => setShowAdd(false)} className="px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-500">取消</button>
          </div>
        </div>
      )}

      {jobs.length === 0 && !showAdd ? (
        <div className="text-center py-12 text-gray-400"><p>暂无外发任务</p>
          <button onClick={() => setShowAdd(true)} className="text-indigo-600 text-sm font-medium hover:underline mt-2">+ 新增外发任务</button></div>
      ) : (
        <div className="space-y-4">
          {jobs.map(job => {
            const st = STATUS_OPTIONS.find(s => s.value === job.status) || STATUS_OPTIONS[0];
            const wip = (job.qty_sent || 0) - (job.qty_pass || 0) - (job.qty_defect || 0) - (job.qty_returned || 0);
            const isEditing = editId === job.id;
            return (
              <div key={job.id} className="border border-gray-200 rounded-xl p-5">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <span className="font-medium text-gray-900">{job.factory_name}</span>
                    <span className="ml-2 text-sm text-gray-500">{JOB_TYPES.find(t=>t.value===job.job_type)?.label}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${st.cls}`}>{st.label}</span>
                    <button onClick={() => deleteOutsourceJob(job.id, orderId).then(reload)} className="text-xs text-red-500 hover:underline">删除</button>
                  </div>
                </div>
                {/* 生产计划信息 */}
                {(job.expected_workers || job.expected_start_date || job.expected_end_date) && (
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 mb-3">
                    {job.expected_workers && <span>上线人数：<strong className="text-gray-700">{job.expected_workers}人</strong></span>}
                    {job.expected_start_date && <span>上线：<strong className="text-gray-700">{job.expected_start_date}</strong></span>}
                    {job.expected_end_date && <span>下线：<strong className="text-gray-700">{job.expected_end_date}</strong></span>}
                    {job.expected_return_date && <span>回厂：<strong className="text-gray-700">{job.expected_return_date}</strong></span>}
                  </div>
                )}
                <div className="grid grid-cols-5 gap-3 mb-3">
                  {[
                    { label: '发出', value: job.qty_sent, color: 'text-gray-700' },
                    { label: '合格', value: job.qty_pass || 0, color: 'text-green-600' },
                    { label: '次品', value: job.qty_defect || 0, color: 'text-red-600' },
                    { label: '回收', value: job.qty_returned || 0, color: 'text-blue-600' },
                    { label: '在制WIP', value: wip > 0 ? wip : 0, color: wip > 0 ? 'text-orange-600' : 'text-gray-400' },
                  ].map(m => (
                    <div key={m.label} className="text-center p-2 bg-gray-50 rounded-lg">
                      <div className={`text-xl font-bold ${m.color}`}>{m.value}</div>
                      <div className="text-xs text-gray-400 mt-0.5">{m.label}</div>
                    </div>
                  ))}
                </div>
                {!isEditing ? (
                  <button onClick={() => { setEditId(job.id); setEditForm({ qty_returned: job.qty_returned?.toString()||'', qty_pass: job.qty_pass?.toString()||'', qty_defect: job.qty_defect?.toString()||'', status: job.status, notes: job.notes||'' }); }}
                    className="text-xs text-indigo-600 font-medium hover:underline">更新数量/状态</button>
                ) : (
                  <div className="bg-gray-50 rounded-lg p-3 mt-2 space-y-2">
                    <div className="grid grid-cols-4 gap-2">
                      <input placeholder="回收数" type="number" value={editForm.qty_returned} onChange={e => setEditForm(f=>({...f, qty_returned: e.target.value}))} className="rounded border border-gray-300 px-2 py-1.5 text-sm" />
                      <input placeholder="合格数" type="number" value={editForm.qty_pass} onChange={e => setEditForm(f=>({...f, qty_pass: e.target.value}))} className="rounded border border-gray-300 px-2 py-1.5 text-sm" />
                      <input placeholder="次品数" type="number" value={editForm.qty_defect} onChange={e => setEditForm(f=>({...f, qty_defect: e.target.value}))} className="rounded border border-gray-300 px-2 py-1.5 text-sm" />
                      <select value={editForm.status} onChange={e => setEditForm(f=>({...f, status: e.target.value}))} className="rounded border border-gray-300 px-2 py-1.5 text-sm">
                        {STATUS_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                      </select>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => handleUpdate(job.id)} disabled={saving} className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-medium disabled:opacity-50">保存</button>
                      <button onClick={() => setEditId(null)} className="px-3 py-1.5 rounded-lg border border-gray-200 text-xs text-gray-500">取消</button>
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
