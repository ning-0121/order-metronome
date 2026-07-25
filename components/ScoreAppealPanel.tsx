'use client';
import { useEffect, useState } from 'react';
import { createClient as createBrowserClient } from '@/lib/supabase/client';
import { listScoreAppeals, submitScoreAppeal, decideScoreAppeal } from '@/app/actions/score-appeals';
import type { AppealType } from '@/lib/domain/scoreAppeal';

const TYPE_LABEL: Record<string, string> = { po_overdue: 'PO逾期', node_overdue: '节点逾期', quality: '质量扣分' };
const CAT_LABEL: Record<string, string> = { customer: '客户原因', supplier: '供应商原因', force_majeure: '不可抗力', system: '系统原因', other: '其他' };
const STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: '待审批', cls: 'bg-amber-100 text-amber-700' },
  approved: { label: '已通过·免扣分', cls: 'bg-green-100 text-green-700' },
  rejected: { label: '已驳回', cls: 'bg-rose-100 text-rose-700' },
};

type MS = { id: string; name: string; step_key?: string; owner_role?: string };

export function ScoreAppealPanel({ orderId, milestones = [] }: { orderId: string; milestones?: MS[] }) {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [form, setForm] = useState<{ appeal_type: AppealType; milestone_id: string; target_key: string; reason_category: string; reason: string; evidence: string[] }>(
    { appeal_type: 'node_overdue', milestone_id: '', target_key: '', reason_category: 'customer', reason: '', evidence: [] });
  const [uploading, setUploading] = useState(false);

  const reload = () => listScoreAppeals(orderId).then((r) => { if (!(r as any).error) setRows((r as any).data || []); });
  useEffect(() => { reload().then(() => setLoading(false)); }, [orderId]);

  const qcNodes = milestones.filter((m) => m.step_key === 'mid_qc_check' || m.step_key === 'final_qc_check');

  async function upload(file: File) {
    setUploading(true); setErr('');
    try {
      const sb = createBrowserClient();
      const path = `score-appeal/${orderId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${file.name.replace(/[^\w.\-]/g, '_')}`;
      const { error } = await sb.storage.from('product-images').upload(path, file, { contentType: file.type });
      if (error) { setErr('证据上传失败:' + error.message); return; }
      const { data } = sb.storage.from('product-images').getPublicUrl(path);
      setForm((f) => ({ ...f, evidence: [...f.evidence, data.publicUrl] }));
    } finally { setUploading(false); }
  }

  async function submit() {
    setSaving(true); setErr('');
    const r = await submitScoreAppeal(orderId, {
      appeal_type: form.appeal_type,
      milestone_id: form.appeal_type === 'po_overdue' ? null : (form.milestone_id || null),
      target_key: form.appeal_type === 'quality' ? (milestones.find((m) => m.id === form.milestone_id)?.step_key || null) : null,
      reason_category: form.reason_category, reason: form.reason, evidence_urls: form.evidence,
    });
    setSaving(false);
    if ((r as any).error) { setErr((r as any).error); return; }
    setShowAdd(false); setForm({ appeal_type: 'node_overdue', milestone_id: '', target_key: '', reason_category: 'customer', reason: '', evidence: [] });
    reload();
  }

  async function decide(id: string, decision: 'approved' | 'rejected') {
    setBusy(id); setErr('');
    const note = decision === 'rejected' ? (window.prompt('驳回理由(可选)') ?? '') : '';
    const r = await decideScoreAppeal(id, decision, note || undefined);
    setBusy(null);
    if ((r as any).error) { setErr((r as any).error); return; }
    reload();
  }

  const inp = 'rounded-lg border border-gray-300 px-3 py-2 text-sm';
  const targetNodes = form.appeal_type === 'quality' ? qcNodes : milestones;

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-semibold text-gray-800">📝 评分申诉</h3>
        {!showAdd && <button onClick={() => setShowAdd(true)} className="text-sm px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700">+ 提申诉</button>}
      </div>
      <p className="text-[11px] text-gray-400 mb-3">非本人可控原因(客户/供应商/不可抗力)导致的扣分可申诉;<b>必须上传证据</b>,节点逾期后 7 天内提出。域经理审批(PO 另需财务、老板可单方定)。</p>

      {showAdd && (
        <div className="bg-indigo-50 rounded-xl p-4 mb-4 space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <select value={form.appeal_type} onChange={(e) => setForm((f) => ({ ...f, appeal_type: e.target.value as AppealType, milestone_id: '' }))} className={`${inp} bg-white`}>
              <option value="node_overdue">节点逾期扣分</option>
              <option value="quality">质量扣分</option>
              <option value="po_overdue">PO逾期罚款</option>
            </select>
            {form.appeal_type !== 'po_overdue' && (
              <select value={form.milestone_id} onChange={(e) => setForm((f) => ({ ...f, milestone_id: e.target.value }))} className={`${inp} bg-white md:col-span-2`}>
                <option value="">选择{form.appeal_type === 'quality' ? '质检' : ''}节点…</option>
                {targetNodes.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            )}
            <select value={form.reason_category} onChange={(e) => setForm((f) => ({ ...f, reason_category: e.target.value }))} className={`${inp} bg-white`}>
              {Object.entries(CAT_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <textarea value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} rows={2} placeholder="申诉说明(如「客户 7/3 才发 PO,附邮件」)" className={`w-full ${inp}`} />
          <div className="flex items-center gap-2 flex-wrap">
            <label className={`text-xs px-3 py-1.5 rounded-lg border border-indigo-200 text-indigo-600 font-medium cursor-pointer hover:bg-indigo-100 ${uploading ? 'opacity-50 pointer-events-none' : ''}`}>
              {uploading ? '上传中…' : '+ 传证据(邮件/函/报告)'}
              <input type="file" className="hidden" accept="image/*,.pdf,.eml,.msg,.xlsx,.docx" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.currentTarget.value = ''; }} />
            </label>
            {form.evidence.map((u, i) => (
              <span key={u} className="text-[11px] px-2 py-0.5 rounded bg-white border border-gray-200 flex items-center gap-1">
                <a href={u} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">证据{i + 1}</a>
                <button onClick={() => setForm((f) => ({ ...f, evidence: f.evidence.filter((x) => x !== u) }))} className="text-red-400">×</button>
              </span>
            ))}
          </div>
          {err && <p className="text-xs text-red-600">{err}</p>}
          <div className="flex gap-2">
            <button onClick={submit} disabled={saving || !form.reason.trim() || form.evidence.length === 0 || (form.appeal_type !== 'po_overdue' && !form.milestone_id)}
              className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium disabled:opacity-50">提交申诉</button>
            <button onClick={() => { setShowAdd(false); setErr(''); }} className="px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-500">取消</button>
          </div>
        </div>
      )}

      {loading ? <p className="text-center py-6 text-gray-400 text-sm">加载中…</p>
        : rows.length === 0 && !showAdd ? <p className="text-center py-8 text-gray-400 text-sm">暂无申诉</p>
        : (
          <div className="space-y-2">
            {rows.map((a) => {
              const st = STATUS[a.status] || STATUS.pending;
              const node = a.milestone_id ? milestones.find((m) => m.id === a.milestone_id) : null;
              return (
                <div key={a.id} className="border border-gray-200 rounded-lg p-3">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-2 flex-wrap text-sm">
                      <span className="font-medium text-gray-900">{TYPE_LABEL[a.appeal_type] || a.appeal_type}</span>
                      {node && <span className="text-gray-500">· {node.name}</span>}
                      <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">{CAT_LABEL[a.reason_category] || a.reason_category}</span>
                    </div>
                    <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${st.cls}`}>{st.label}</span>
                  </div>
                  <p className="text-xs text-gray-600 mt-1">{a.reason}</p>
                  <div className="flex items-center gap-2 flex-wrap mt-1 text-[11px]">
                    {(a.evidence_urls || []).map((u: string, i: number) => <a key={u} href={u} target="_blank" rel="noreferrer" className="px-1.5 py-0.5 rounded border border-indigo-200 text-indigo-600 hover:bg-indigo-50">证据{i + 1}</a>)}
                    <span className="text-gray-400 ml-auto">{a.submitter_name || ''} · {new Date(a.created_at).toLocaleDateString('zh-CN')}</span>
                  </div>
                  {a.status === 'pending' && (
                    <div className="flex gap-2 mt-2">
                      <button onClick={() => decide(a.id, 'approved')} disabled={busy === a.id} className="text-xs px-3 py-1 rounded-lg bg-green-50 text-green-700 font-medium hover:bg-green-100 disabled:opacity-50">批准</button>
                      <button onClick={() => decide(a.id, 'rejected')} disabled={busy === a.id} className="text-xs px-3 py-1 rounded-lg bg-rose-50 text-rose-700 font-medium hover:bg-rose-100 disabled:opacity-50">驳回</button>
                      <span className="text-[11px] text-gray-400 self-center">（审批人:{a.appeal_type === 'po_overdue' ? '业务经理+财务' : a.reviewer_role === 'production_manager' ? '生产主管' : a.reviewer_role === 'procurement_manager' ? '采购经理' : '业务经理'}，老板可单方定）</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      {err && !showAdd && <p className="text-xs text-red-600 mt-2">{err}</p>}
    </div>
  );
}
