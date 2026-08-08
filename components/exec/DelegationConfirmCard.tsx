'use client';

/**
 * CEO 确认卡(Executive OS V1 TS1)—— AI 草案 → CEO 一次确认。
 * 修正④:deadline 固化前必须显示**绝对日期时间 + 时区**;修正③:未匹配实体明示。
 * 三选一:确认并分配 / 修改 / 只记录(不分配)。
 */

import { useState } from 'react';
import { confirmDelegation } from '@/app/actions/exec-delegation';

interface OwnerOption { user_id: string; name: string }

export interface DraftItem {
  id: string;                    // capture_item_id
  captureId: string;
  title: string;
  instruction: string;
  ownerHint?: string;
  ownerResolved?: OwnerOption | null;   // 后端消歧结果(唯一命中才有)
  ownerCandidates?: OwnerOption[];      // 歧义/未命中时候选
  deadlineText?: string;         // 原文"明天下午前"
  deadlineAbsolute?: string;     // 后端解析的绝对 ISO(可空 → 强制 CEO 补)
  deadlineTz?: string;
  deadlineConfidence?: number;
  acceptanceCriteria?: string;
  constraints?: any;
  counterpartyName?: string;
  counterpartyResolved?: boolean;
}

export function DelegationConfirmCard({ draft, onDone }: { draft: DraftItem; onDone: () => void }) {
  const [ownerId, setOwnerId] = useState(draft.ownerResolved?.user_id || '');
  const [deadline, setDeadline] = useState(draft.deadlineAbsolute || '');   // datetime-local
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const fmtAbs = (iso: string) => {
    if (!iso) return '';
    try { return new Date(iso).toLocaleString('zh-CN', { timeZone: draft.deadlineTz || 'Asia/Shanghai', hour12: false }); }
    catch { return iso; }
  };

  async function handleConfirm() {
    setErr('');
    if (!ownerId) { setErr('请先指定负责人 —— 未匹配到员工时不能确认'); return; }
    if (!deadline) { setErr('请确认截止时间(必须是明确的日期时间)'); return; }
    setBusy(true);
    const absIso = new Date(deadline).toISOString();
    const res = await confirmDelegation({
      captureId: draft.captureId, captureItemId: draft.id,
      title: draft.title, instruction: draft.instruction,
      ownerUserId: ownerId, deadline: absIso, deadlineTz: draft.deadlineTz || 'Asia/Shanghai',
      deadlineSourceText: draft.deadlineText || null, deadlineConfidence: draft.deadlineConfidence ?? null,
      acceptanceCriteria: draft.acceptanceCriteria || null, constraints: draft.constraints || null,
      counterpartyName: draft.counterpartyName || null,
      counterpartyId: null,   // 修正③:不自动建客户;tentative 交后端
    });
    setBusy(false);
    if (res.error) { setErr(res.error); return; }
    onDone();
  }

  const ownerOpts = draft.ownerCandidates?.length ? draft.ownerCandidates : (draft.ownerResolved ? [draft.ownerResolved] : []);

  return (
    <div className="rounded-2xl border border-indigo-200 bg-white shadow-sm p-5 space-y-3">
      <div className="text-xs text-indigo-500 font-semibold">我理解你要交代:</div>
      <div className="text-base font-semibold text-gray-900">{draft.title}</div>
      <div className="text-sm text-gray-700 whitespace-pre-wrap">{draft.instruction}</div>

      {/* 负责人 —— 未匹配明示 */}
      <div className="text-sm">
        <span className="text-gray-500">负责人:</span>{' '}
        {ownerOpts.length > 0 ? (
          <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} className="border rounded px-2 py-1 text-sm">
            <option value="">选择…</option>
            {ownerOpts.map((o) => <option key={o.user_id} value={o.user_id}>{o.name}</option>)}
          </select>
        ) : (
          <span className="text-red-600">⚠ "{draft.ownerHint || '未指定'}" 未匹配到员工,请手动选择后才能分配</span>
        )}
      </div>

      {/* 截止 —— 必须显示绝对时间+时区 */}
      <div className="text-sm">
        <span className="text-gray-500">截止:</span>{' '}
        <input type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)}
          className="border rounded px-2 py-1 text-sm" />
        {draft.deadlineText && <span className="text-xs text-gray-400 ml-2">(原话:{draft.deadlineText})</span>}
        {deadline && <div className="text-xs text-gray-500 mt-1">→ {fmtAbs(new Date(deadline).toISOString())}(Asia/Shanghai)</div>}
      </div>

      {draft.acceptanceCriteria && (
        <div className="text-sm"><span className="text-gray-500">验收:</span> {draft.acceptanceCriteria}</div>
      )}
      {draft.counterpartyName && !draft.counterpartyResolved && (
        <div className="text-xs text-amber-600">⚠ 对手方「{draft.counterpartyName}」未在系统中匹配到客户,将暂存为待确认(不自动建档)</div>
      )}

      {err && <div className="text-sm text-red-600">{err}</div>}

      <div className="flex gap-2 pt-1">
        <button onClick={handleConfirm} disabled={busy}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-700 disabled:opacity-50">
          {busy ? '分配中…' : '确认并分配'}
        </button>
        <button onClick={onDone} disabled={busy} className="rounded-lg border px-4 py-2 text-sm text-gray-600">只记录/关闭</button>
      </div>
    </div>
  );
}
