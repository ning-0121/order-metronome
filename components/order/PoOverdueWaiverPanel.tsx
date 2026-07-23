'use client';

import { useState } from 'react';
import { requestPoOverdueWaiver, reviewPoOverdueWaiver, type PoWaiver } from '@/app/actions/po-overdue';

const DEC = (d: string | null) => d === 'approved' ? '✅通过' : d === 'rejected' ? '❌驳回' : '待定';

export function PoOverdueWaiverPanel({ orderId, overdueDays, penaltyAmount, baselineDate, waived, waiver, canRequest, canReview }: {
  orderId: string;
  overdueDays: number;
  penaltyAmount: number;
  baselineDate: string | null;
  waived: boolean;
  waiver: PoWaiver | null;
  canRequest: boolean;   // 业务(订单 owner)可申请
  canReview: boolean;    // 业务执行经理/财务/老板可审批
}) {
  const [reason, setReason] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // 已免罚 → 绿色
  if (waived) {
    return (
      <div className="rounded-xl border border-green-300 bg-green-50 px-4 py-3 flex items-start gap-3">
        <span className="text-xl shrink-0">✅</span>
        <div className="text-sm">
          <p className="font-semibold text-green-900">PO 逾期罚款已免除</p>
          <p className="text-green-700 mt-0.5">本单 PO 逾期 {overdueDays} 天上传,已通过免罚审批,不计罚款、不计逾期考核。</p>
        </div>
      </div>
    );
  }

  async function submitRequest() {
    if (!reason.trim()) { setErr('请填写理由'); return; }
    setBusy(true); setErr('');
    const res = await requestPoOverdueWaiver(orderId, reason);
    setBusy(false);
    if (res.error) { setErr(res.error); return; }
    location.reload();
  }
  async function review(decision: 'approved' | 'rejected') {
    if (!waiver) return;
    const note = prompt(decision === 'approved' ? '通过备注(可留空)' : '驳回原因(可留空)') ?? '';
    setBusy(true); setErr('');
    const res = await reviewPoOverdueWaiver(waiver.id, decision, note);
    setBusy(false);
    if (res.error) { setErr(res.error); return; }
    location.reload();
  }

  const pending = waiver && waiver.status === 'pending';

  return (
    <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-3">
      <div className="flex items-start gap-3">
        <span className="text-xl shrink-0">⚠️</span>
        <div className="text-sm flex-1 min-w-0">
          <p className="font-semibold text-red-900">PO 逾期上传 · 罚款 ¥{penaltyAmount || 200}</p>
          <p className="text-red-700 mt-0.5">
            客户下达日 {baselineDate || '—'},逾期 <b>{overdueDays} 天</b> 才建单/上传 PO。已记罚款 ¥{penaltyAmount || 200} + 扣绩效,并已上报业务执行经理 / 财务 / 老板。
          </p>

          {/* 申请免罚(业务) */}
          {!waiver && canRequest && !showForm && (
            <button onClick={() => setShowForm(true)} className="mt-2 text-xs px-3 py-1.5 rounded-lg bg-white border border-red-300 text-red-700 font-medium hover:bg-red-100">
              申请免罚
            </button>
          )}
          {!waiver && canRequest && showForm && (
            <div className="mt-2 space-y-2">
              <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2}
                placeholder="填写正当理由(如客户当日未发正式 PO、系统故障等),提交业务执行经理 + 财务审核"
                className="w-full rounded-lg border border-red-200 px-3 py-2 text-xs" />
              <div className="flex gap-2">
                <button onClick={submitRequest} disabled={busy} className="text-xs px-3 py-1.5 rounded-lg bg-red-600 text-white font-medium hover:bg-red-700 disabled:opacity-50">
                  {busy ? '提交中…' : '提交免罚申请'}
                </button>
                <button onClick={() => { setShowForm(false); setReason(''); }} className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-500">取消</button>
              </div>
            </div>
          )}

          {/* 免罚申请审批中 */}
          {pending && (
            <div className="mt-2 rounded-lg bg-white border border-red-200 p-2.5">
              <p className="text-xs text-gray-700">
                <b>免罚申请审批中</b> · 申请人 {waiver!.requester_name || '业务'} · 理由:{waiver!.reason}
              </p>
              <p className="text-[11px] text-gray-500 mt-1">
                业务执行经理 {DEC(waiver!.order_manager_decision)} · 财务 {DEC(waiver!.finance_decision)} · 老板 {DEC(waiver!.admin_override)}
                <span className="ml-1 text-gray-400">(两方通过或老板批准即免罚)</span>
              </p>
              {canReview && (
                <div className="flex gap-2 mt-2">
                  <button onClick={() => review('approved')} disabled={busy} className="text-xs px-3 py-1.5 rounded-lg bg-green-600 text-white font-medium hover:bg-green-700 disabled:opacity-50">✓ 通过免罚</button>
                  <button onClick={() => review('rejected')} disabled={busy} className="text-xs px-3 py-1.5 rounded-lg bg-gray-600 text-white font-medium hover:bg-gray-700 disabled:opacity-50">✕ 驳回</button>
                </div>
              )}
            </div>
          )}

          {/* 上一次申请被驳回,可再申请 */}
          {waiver && waiver.status === 'rejected' && canRequest && !showForm && (
            <div className="mt-2">
              <p className="text-[11px] text-gray-500 mb-1">上次免罚申请已被驳回,罚款保留。</p>
              <button onClick={() => setShowForm(true)} className="text-xs px-3 py-1.5 rounded-lg bg-white border border-red-300 text-red-700 font-medium hover:bg-red-100">重新申请免罚</button>
            </div>
          )}

          {err && <p className="text-xs text-red-600 mt-1.5">{err}</p>}
        </div>
      </div>
    </div>
  );
}
