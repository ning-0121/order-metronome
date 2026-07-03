'use client';

/**
 * 节点体系 V2 · P1b —— 节点「多方确认」面板
 * 只在配置了多方确认的节点(PO确认/产前会/产前样/尾查/发货出运)渲染。
 * 每方一个 chip:✅已确认(谁/何时) 或 ⬜待确认(+确认按钮,仅角色匹配者可见)。
 * 全部确认:免证据节点自动完成;要证据节点提示上传凭证后照常点完成。
 */

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { listMilestoneConfirmations, confirmMilestoneParty } from '@/app/actions/milestone-confirmations';
import { requiredPartiesFor } from '@/lib/domain/confirmationParties';

interface PartyRow {
  party_key: string; party_label: string; hint?: string;
  status: 'pending' | 'confirmed';
  confirmed_at?: string | null; confirmed_by_name?: string | null; note?: string | null;
  canConfirm: boolean;
}

export function MilestoneConfirmations({ milestoneId, stepKey, milestoneStatus }: {
  milestoneId: string;
  stepKey: string;
  milestoneStatus?: string;
}) {
  const router = useRouter();
  // 纯配置判定(客户端零请求):非多方节点直接不渲染
  const isMultiParty = requiredPartiesFor(stepKey).length > 0;
  const [parties, setParties] = useState<PartyRow[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    const res = await listMilestoneConfirmations(milestoneId);
    if (res.parties) setParties(res.parties);
    else if (res.error) setMsg(res.error);
  }, [milestoneId]);

  useEffect(() => { if (isMultiParty) load(); }, [isMultiParty, load]);

  if (!isMultiParty) return null;

  const isDone = ['done', '已完成'].includes(String(milestoneStatus || '').toLowerCase());

  async function confirm(p: PartyRow) {
    const note = window.prompt(`代表「${p.party_label}」确认${p.hint ? `\n(${p.hint})` : ''}\n\n可填确认留言(选填):`, '');
    if (note === null) return;                     // 取消
    setConfirming(p.party_key); setMsg('');
    const res = await confirmMilestoneParty(milestoneId, p.party_key, note || undefined);
    setConfirming(null);
    if (res.error) { setMsg(res.error); return; }
    if (res.autoCompleted) setMsg('✅ 各方确认完毕,节点已自动完成');
    else if (res.needsEvidence) setMsg('✅ 各方确认完毕 — 请上传凭证后点「标记完成」');
    else if (res.allConfirmed) setMsg('✅ 各方确认完毕');
    else setMsg('✅ 已确认,等待其他方');
    await load();
    router.refresh();
  }

  const fmtDate = (iso?: string | null) => iso ? new Date(iso).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : '';

  return (
    <div className="mt-2 rounded-lg border border-indigo-100 bg-indigo-50/50 p-2.5">
      <p className="text-xs font-semibold text-indigo-800 mb-1.5">
        🤝 多方确认{isDone ? '(节点已完成)' : ''} — 全部确认后节点才算完成
      </p>
      <div className="flex flex-wrap gap-1.5">
        {(parties || requiredPartiesFor(stepKey).map((p): PartyRow => ({
          party_key: p.key, party_label: p.label, hint: p.hint,
          status: 'pending', canConfirm: false,
          confirmed_at: null, confirmed_by_name: null, note: null,
        }))).map(p => (
          <span key={p.party_key}
            title={[p.hint, p.note ? `留言:${p.note}` : ''].filter(Boolean).join(' · ')}
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs border ${
              p.status === 'confirmed'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                : 'bg-white border-gray-200 text-gray-600'
            }`}>
            {p.status === 'confirmed'
              ? <>✅ {p.party_label}{p.confirmed_by_name ? ` · ${p.confirmed_by_name}` : ''}{p.confirmed_at ? ` ${fmtDate(p.confirmed_at)}` : ''}</>
              : <>⬜ {p.party_label}
                  {!isDone && p.canConfirm && (
                    <button onClick={() => confirm(p)} disabled={confirming === p.party_key}
                      className="ml-0.5 rounded bg-indigo-600 px-1.5 py-px text-[11px] font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
                      {confirming === p.party_key ? '…' : '确认'}
                    </button>
                  )}
                </>}
          </span>
        ))}
      </div>
      {msg && <p className="mt-1.5 text-xs text-indigo-700">{msg}</p>}
    </div>
  );
}
