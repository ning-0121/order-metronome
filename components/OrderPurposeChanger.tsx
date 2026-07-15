'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  changeOrderPurpose,
  requestOrderPurposeChange,
  decideOrderPurposeChange,
  getPurposeChangeRequests,
} from '@/app/actions/orders';

const PURPOSE_LABEL: Record<string, string> = {
  production: '自产(标准生产)',
  trade: '经销 / 采购成品',
  consign: '委托加工 / 外发(料工厂自采)',
  sample: '样品单',
  inquiry: '询价单',
};

const CHANGEABLE = [
  { value: 'production', label: '自产(标准生产)', hint: '绮陌自采原辅料、走采购核料下单' },
  { value: 'consign', label: '委托加工 / 外发', hint: '料由工厂自采,不走采购核料(砍掉「采购下单」节点)' },
  { value: 'trade', label: '经销 / 采购成品', hint: '直接采购成品,精简流程、无原辅料核料' },
];

type Mode = 'direct' | 'request' | 'approve' | 'view';

/**
 * 「订单用途」展示 + 改用途流程。
 *  - 财务/管理员(canApprove):可「直接改」;有待审批申请时可「批准/驳回」。
 *  - 业务执行(canRequest):「申请改用途」→ 提交待审批,财务/管理员审批后才落库。
 * 改用途通过后由 server action 温和重算里程碑(保留已完成进度)。
 */
export function OrderPurposeChanger({
  orderId,
  currentPurpose,
  canApprove,
  canRequest,
}: {
  orderId: string;
  currentPurpose: string;
  canApprove: boolean;
  canRequest: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<any | null>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('direct');
  const [target, setTarget] = useState(currentPurpose);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const cur = currentPurpose || 'production';
  const curLabel = PURPOSE_LABEL[cur] || cur;

  async function loadPending() {
    const res = await getPurposeChangeRequests(orderId);
    setPending((res.data && res.data[0]) || null);
  }
  useEffect(() => { loadPending(); /* eslint-disable-next-line */ }, [orderId]);

  function openDialog(m: Mode) {
    setMode(m); setTarget(cur); setReason(''); setNote(''); setError(''); setOpen(true);
  }

  async function submitChange() {
    setError('');
    if (target === cur) { setError('用途未改变'); return; }
    setSaving(true);
    const res = mode === 'request'
      ? await requestOrderPurposeChange(orderId, target, reason.trim() || undefined)
      : await changeOrderPurpose(orderId, target, reason.trim() || undefined);
    setSaving(false);
    if (res.error) { setError(res.error); return; }
    setOpen(false);
    await loadPending();
    router.refresh();
  }

  async function decide(approve: boolean) {
    setError(''); setSaving(true);
    const res = await decideOrderPurposeChange(pending.id, approve, note.trim() || undefined);
    setSaving(false);
    if (res.error) { setError(res.error); return; }
    setOpen(false);
    await loadPending();
    router.refresh();
  }

  const pLabel = (v: string) => PURPOSE_LABEL[v] || v;

  return (
    <span className="inline-flex items-center gap-2 flex-wrap justify-end">
      <span className="text-gray-900">{curLabel}</span>

      {pending ? (
        <button
          type="button"
          onClick={() => openDialog(canApprove ? 'approve' : 'view')}
          className="text-xs px-2 py-0.5 rounded-md bg-amber-100 text-amber-800 border border-amber-200 hover:bg-amber-200"
          title="有待审批的改用途申请"
        >
          ⏳ 改用途审批中{canApprove ? ' · 去审批' : ''}
        </button>
      ) : canApprove ? (
        <button type="button" onClick={() => openDialog('direct')}
          className="text-xs px-2 py-0.5 rounded-md border border-indigo-200 text-indigo-600 hover:bg-indigo-50"
          title="经销/委托单被建成了自产?在此改正,里程碑会按新用途重算">
          改
        </button>
      ) : canRequest ? (
        <button type="button" onClick={() => openDialog('request')}
          className="text-xs px-2 py-0.5 rounded-md border border-indigo-200 text-indigo-600 hover:bg-indigo-50"
          title="申请修改订单用途,提交财务/管理员审批">
          申请改用途
        </button>
      ) : null}

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !saving && setOpen(false)}>
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl text-left" onClick={e => e.stopPropagation()}>

            {/* 审批 / 查看 */}
            {(mode === 'approve' || mode === 'view') && pending && (
              <>
                <h3 className="text-base font-semibold text-gray-900">改用途申请{mode === 'view' ? '(待审批)' : '审批'}</h3>
                <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm">
                  <div><b>{pLabel(pending.from_purpose)}</b> → <b className="text-amber-800">{pLabel(pending.to_purpose)}</b></div>
                  <div className="mt-1 text-xs text-gray-500">申请人:{pending.requester_name || '业务'}</div>
                  {pending.reason && <div className="mt-1 text-xs text-gray-600">原因:{pending.reason}</div>}
                </div>
                <p className="mt-2 text-xs text-gray-500">
                  批准后会按新用途<b>重算里程碑</b>(已完成节点保留,未完成的多余节点移除),并记你为审批人。
                </p>
                {mode === 'approve' && (
                  <textarea value={note} onChange={e => setNote(e.target.value)} placeholder="审批备注(选填)" rows={2}
                    className="mt-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
                )}
                {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
                <div className="mt-4 flex justify-end gap-2">
                  <button type="button" onClick={() => setOpen(false)} disabled={saving}
                    className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">关闭</button>
                  {mode === 'approve' && (
                    <>
                      <button type="button" onClick={() => decide(false)} disabled={saving}
                        className="rounded-lg border border-red-300 px-4 py-2 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50">
                        {saving ? '…' : '驳回'}
                      </button>
                      <button type="button" onClick={() => decide(true)} disabled={saving}
                        className="rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white font-medium hover:bg-indigo-700 disabled:opacity-50">
                        {saving ? '处理中…' : '批准并执行'}
                      </button>
                    </>
                  )}
                </div>
                {mode === 'view' && <p className="mt-3 text-xs text-gray-400 text-center">待财务/管理员审批,通过后自动生效</p>}
              </>
            )}

            {/* 直接改 / 申请 */}
            {(mode === 'direct' || mode === 'request') && (
              <>
                <h3 className="text-base font-semibold text-gray-900">{mode === 'request' ? '申请修改订单用途' : '修改订单用途'}</h3>
                <p className="mt-1 text-xs text-gray-500">
                  当前:<b>{curLabel}</b>。{mode === 'request'
                    ? '提交后需财务/管理员审批,通过才生效。'
                    : '改用途会按新用途重算里程碑(已完成保留,未完成的多余节点移除),此操作留痕。'}
                </p>
                <div className="mt-4 space-y-2">
                  {CHANGEABLE.map(opt => (
                    <label key={opt.value}
                      className={`flex items-start gap-2.5 rounded-xl border p-3 cursor-pointer ${target === opt.value ? 'border-indigo-400 bg-indigo-50' : 'border-gray-200 hover:bg-gray-50'}`}>
                      <input type="radio" name="purpose" value={opt.value} checked={target === opt.value}
                        onChange={() => setTarget(opt.value)} className="mt-0.5" />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-gray-900">
                          {opt.label}{opt.value === cur && <span className="ml-1 text-xs text-gray-400">(当前)</span>}
                        </span>
                        <span className="block text-xs text-gray-500">{opt.hint}</span>
                      </span>
                    </label>
                  ))}
                </div>
                <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2}
                  placeholder="原因(选填,如:经销单建成了自产,改正)"
                  className="mt-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
                {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
                <div className="mt-4 flex justify-end gap-2">
                  <button type="button" onClick={() => setOpen(false)} disabled={saving}
                    className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">取消</button>
                  <button type="button" onClick={submitChange} disabled={saving || target === cur}
                    className="rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white font-medium hover:bg-indigo-700 disabled:opacity-50">
                    {saving ? '提交中…' : (mode === 'request' ? '提交申请' : '确认修改')}
                  </button>
                </div>
              </>
            )}

          </div>
        </div>
      )}
    </span>
  );
}
