'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { decideBudgetApproval } from '@/app/actions/budget-approvals';

/**
 * 超预算提交采购 —— 审批横幅(订单详情顶部)。
 * 业务经理批 mgr;财务批 fin(仅 needs_finance)。批过后业务即可提交采购。
 */
export function BudgetApprovalBanner({ approval, canMgr, canFin }: { approval: any; canMgr: boolean; canFin: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');
  if (!approval || approval.status !== 'pending') return null;

  const mgrPending = approval.mgr_status === 'pending';
  const finPending = approval.needs_finance && approval.fin_status === 'pending';
  const canActMgr = canMgr && mgrPending;
  const canActFin = canFin && finPending;

  async function act(role: 'mgr' | 'fin', decision: 'approved' | 'rejected') {
    let note: string | undefined;
    if (decision === 'rejected') {
      note = window.prompt('驳回理由(必填):') || '';
      if (!note.trim()) return;
    }
    setBusy(`${role}:${decision}`); setErr('');
    const res = await decideBudgetApproval(approval.id, decision, note);
    setBusy(null);
    if (res.error) { setErr(res.error); return; }
    router.refresh();
  }

  const lines: any[] = approval.over_lines || [];
  return (
    <div className="mb-4 rounded-xl border border-orange-300 bg-orange-50 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-orange-800">🟠 超预算待审批</span>
        <span className="text-xs text-orange-700">
          原辅料单耗超报价基线(最高 +{Math.round(Number(approval.max_over_pct) || 0)}%),
          需 {approval.needs_finance ? '业务执行经理 + 财务' : '业务执行经理'} 批准后才能提交采购。
        </span>
      </div>
      {lines.length > 0 && (
        <div className="mt-1.5 text-xs text-orange-700 space-y-0.5">
          {lines.slice(0, 8).map((l, i) => (
            <div key={i}>· {l.material}:单耗 {l.bom_cons} &gt; 基线 {l.base_cons}(<b>+{l.over_pct}%</b>)</div>
          ))}
          {lines.length > 8 && <div>…还有 {lines.length - 8} 项</div>}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <span className={`px-2 py-0.5 rounded ${approval.mgr_status === 'approved' ? 'bg-emerald-100 text-emerald-700' : approval.mgr_status === 'rejected' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600'}`}>
          业务经理:{approval.mgr_status === 'approved' ? '已批' : approval.mgr_status === 'rejected' ? '驳回' : '待批'}
        </span>
        {approval.needs_finance && (
          <span className={`px-2 py-0.5 rounded ${approval.fin_status === 'approved' ? 'bg-emerald-100 text-emerald-700' : approval.fin_status === 'rejected' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600'}`}>
            财务:{approval.fin_status === 'approved' ? '已批' : approval.fin_status === 'rejected' ? '驳回' : '待批'}
          </span>
        )}
        {canActMgr && (
          <>
            <button disabled={!!busy} onClick={() => act('mgr', 'approved')} className="px-2.5 py-1 rounded bg-emerald-600 text-white font-medium hover:bg-emerald-700 disabled:opacity-50">经理批准</button>
            <button disabled={!!busy} onClick={() => act('mgr', 'rejected')} className="px-2.5 py-1 rounded border border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-50">经理驳回</button>
          </>
        )}
        {canActFin && (
          <>
            <button disabled={!!busy} onClick={() => act('fin', 'approved')} className="px-2.5 py-1 rounded bg-emerald-600 text-white font-medium hover:bg-emerald-700 disabled:opacity-50">财务批准</button>
            <button disabled={!!busy} onClick={() => act('fin', 'rejected')} className="px-2.5 py-1 rounded border border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-50">财务驳回</button>
          </>
        )}
      </div>
      {err && <p className="mt-1.5 text-xs text-red-600">{err}</p>}
    </div>
  );
}
