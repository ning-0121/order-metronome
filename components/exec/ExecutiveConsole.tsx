'use client';

/**
 * Executive OS V1 Thin Slice 1 — 自包含控制台(flag EXEC_OS_V1 才挂载)。
 * CEO:交代输入 → 确认卡 → 你委托的。员工:派给我的委托 → 提交。
 * TS1 员工端**直读 executive_delegations**(不走 daily_tasks 投影,修正⑥)。
 */

import { useEffect, useState } from 'react';
import { captureCeoInput, parseCapture } from '@/app/actions/exec-capture';
import { prepareDelegationDrafts, getCeoDelegations, getMyDelegations, submitDelegation, verifyDelegation, abandonCapture } from '@/app/actions/exec-delegation';
import { DelegationConfirmCard, type DraftItem } from './DelegationConfirmCard';

export function ExecutiveConsole({ isCeo }: { isCeo: boolean }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [drafts, setDrafts] = useState<DraftItem[]>([]);
  const [mine, setMine] = useState<any[]>([]);
  const [ceoList, setCeoList] = useState<any[]>([]);

  async function refresh() {
    if (isCeo) setCeoList((await getCeoDelegations()).data || []);
    setMine((await getMyDelegations()).data || []);
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, []);

  async function handleCapture() {
    if (!text.trim()) return;
    setBusy(true); setMsg('AI 正在理解…'); setDrafts([]);
    const idem = `ceo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const cap = await captureCeoInput(text, idem);
    if (cap.error || !cap.captureId) { setBusy(false); setMsg('❌ ' + (cap.error || '捕获失败')); return; }
    const parsed = await parseCapture(cap.captureId);
    if (parsed.error && !(parsed.items && parsed.items.length)) { setBusy(false); setMsg('❌ ' + parsed.error); return; }
    const prep = await prepareDelegationDrafts(cap.captureId);
    setBusy(false);
    if (prep.error) { setMsg('❌ ' + prep.error); return; }
    setDrafts((prep.drafts || []) as DraftItem[]);
    setMsg((prep.drafts || []).length ? '' : '没抽到可分配的委托,可重述或手动补。');
  }

  return (
    <div className="space-y-6">
      {isCeo && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-gray-700">🎙 交代一件事</h2>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3}
            placeholder="例:让欧璐把 Gregory 当前项目的新报价明天下午前做好,利润低于15%不要发。"
            className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
          <div className="flex items-center gap-3">
            <button onClick={handleCapture} disabled={busy}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-700 disabled:opacity-50">
              {busy ? '处理中…' : '理解并生成确认卡'}
            </button>
            {msg && <span className="text-sm text-gray-500">{msg}</span>}
          </div>
          {drafts.map((d) => (
            <DelegationConfirmCard key={d.id} draft={d} onDone={(confirmed) => {
              if (!confirmed) void abandonCapture(d.captureId);
              setDrafts((p) => p.filter((x) => x.id !== d.id)); refresh();
            }} />
          ))}
        </section>
      )}

      {isCeo && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-gray-700">📋 你委托的</h2>
          {ceoList.length === 0 && <p className="text-sm text-gray-400">暂无</p>}
          {ceoList.map((d) => <CeoRow key={d.id} d={d} onChange={refresh} />)}
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-gray-700">📥 派给我的委托</h2>
        {mine.length === 0 && <p className="text-sm text-gray-400">暂无</p>}
        {mine.map((d) => <EmployeeRow key={d.id} d={d} onChange={refresh} />)}
      </section>
    </div>
  );
}

function CeoRow({ d, onChange }: { d: any; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  async function verify() { setBusy(true); await verifyDelegation(d.id); setBusy(false); onChange(); }
  return (
    <div className="rounded-lg border border-gray-200 p-3 text-sm flex items-center justify-between gap-2">
      <div><b>{d.title}</b> <span className="text-gray-400">· 截止 {d.deadline ? new Date(d.deadline).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '—'}</span></div>
      <div className="flex items-center gap-2">
        <StatusBadge d={d} />
        {d.delegation_status === 'submitted' && (
          <button onClick={verify} disabled={busy} className="rounded bg-indigo-600 text-white px-2 py-0.5 text-xs disabled:opacity-50">{busy ? '核对中…' : '核对'}</button>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ d }: { d: any }) {
  const s = d.delegation_status;
  const color = s === 'verified' ? 'bg-green-100 text-green-700' : s === 'rework' ? 'bg-red-100 text-red-700'
    : s === 'submitted' || s === 'verifying' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-600';
  const label: Record<string, string> = { assigned: '已分配', in_progress: '进行中', submitted: '待核对', verifying: '核对中', verified: '✅ 已验证', rework: '↩ 返工', confirmed: '已确认' };
  return <span className={`px-2 py-0.5 rounded text-xs ${color}`}>{label[s] || s}{d.verification_reason ? ` · ${d.verification_reason}` : ''}</span>;
}

function EmployeeRow({ d, onChange }: { d: any; onChange: () => void }) {
  const [summary, setSummary] = useState('');
  const [orderId, setOrderId] = useState(d.linked_order_id || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const canSubmit = ['assigned', 'in_progress', 'rework'].includes(d.delegation_status);

  async function submit() {
    setBusy(true); setErr('');
    const res = await submitDelegation(d.id, { summary, linkedOrderId: orderId || null });
    setBusy(false);
    if (res.error) { setErr(res.error); return; }
    onChange();
  }
  return (
    <div className="rounded-lg border border-gray-200 p-3 text-sm space-y-2">
      <div><b>{d.title}</b> <StatusBadge d={d} /></div>
      <div className="text-gray-600">{d.instruction}</div>
      {d.acceptance_criteria && <div className="text-xs text-gray-500">验收:{d.acceptance_criteria}</div>}
      {canSubmit && (
        <div className="flex flex-wrap items-center gap-2">
          <input value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="提交说明" className="border rounded px-2 py-1 text-sm flex-1 min-w-40" />
          <input value={orderId} onChange={(e) => setOrderId(e.target.value)} placeholder="关联订单ID(核利润用)" className="border rounded px-2 py-1 text-sm w-56" />
          <button onClick={submit} disabled={busy} className="rounded bg-gray-800 text-white px-3 py-1 text-sm disabled:opacity-50">{busy ? '提交中…' : '提交成果'}</button>
        </div>
      )}
      {err && <div className="text-xs text-red-600">{err}</div>}
    </div>
  );
}
