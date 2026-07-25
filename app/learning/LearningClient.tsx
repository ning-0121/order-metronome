'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { evaluateMaterialDecision } from '@/app/actions/material-decisions';
import { REASON_CODE_OPTIONS, type OutcomeResult } from '@/lib/knowledge/types';

const REASON_LABEL: Record<string, string> = Object.fromEntries(REASON_CODE_OPTIONS.map(o => [o.value, o.label]));
const TYPE_LABEL: Record<string, string> = {
  consumption_change: '改单耗', material_swap: '换料', line_add: '新增', line_delete: '删除',
  qty_override: '改数量', supplier_change: '换供应商', other: '其他',
};
const STATUS_LABEL: Record<string, string> = {
  draft: '草稿', confirmed: '已确认', outcome_pending: '待评估', evaluated: '已评估', closed: '已关闭', superseded: '已更正',
};
const OUTCOME_OPTIONS: { value: OutcomeResult; label: string }[] = [
  { value: 'correct', label: '决策正确' },
  { value: 'too_low_caused_supplement', label: '单耗偏低 → 导致补料' },
  { value: 'too_high_caused_waste', label: '单耗偏高 → 导致浪费' },
  { value: 'inconclusive', label: '无法判定' },
];

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3">
      <div className={`text-2xl font-bold ${tone || 'text-gray-900'}`}>{value}</div>
      <div className="text-xs text-gray-500 mt-0.5">{label}</div>
    </div>
  );
}

export function LearningClient({ initial, canEvaluate }: { initial: any[]; canEvaluate: boolean }) {
  const [rows, setRows] = useState<any[]>(initial || []);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<OutcomeResult | ''>('');
  const [wasCorrect, setWasCorrect] = useState<'yes' | 'no' | ''>('');
  const [cause, setCause] = useState('');

  const pending = rows.filter(r => r.status === 'confirmed' || r.status === 'outcome_pending');
  const noEvidence = rows.filter(r => !(Array.isArray(r.evidence_refs) && r.evidence_refs.length));

  const topReasons = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach(r => m.set(r.reason_code, (m.get(r.reason_code) || 0) + 1));
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [rows]);

  async function submitEval(id: string) {
    if (!outcome) { alert('请选择结果判定'); return; }
    if (!wasCorrect) { alert('请判断当初决策是否正确'); return; }
    setBusy(true);
    const res = await evaluateMaterialDecision(id, {
      outcomeResult: outcome, wasCorrect: wasCorrect === 'yes', attributedCause: cause || undefined,
    });
    setBusy(false);
    if (!res.ok) { alert('评估失败：' + res.error); return; }
    setRows(prev => prev.map(r => r.id === id
      ? { ...r, status: 'evaluated', outcome_result: outcome, outcome_was_correct: wasCorrect === 'yes', outcome_attributed_cause: cause || null }
      : r));
    setEditingId(null); setOutcome(''); setWasCorrect(''); setCause('');
  }

  const signalSummary = (r: any): string => {
    const s = r.outcome_auto_signals;
    if (!s) return '—';
    const bits: string[] = [];
    if (s.is_supplement) bits.push('⚠ 有补料');
    if (s.over_purchase === true) bits.push('超买');
    if (typeof s.cost_variance_pct === 'number') bits.push(`成本差 ${(s.cost_variance_pct * 100).toFixed(0)}%`);
    if (s.suggested_result) bits.push(`建议:${OUTCOME_OPTIONS.find(o => o.value === s.suggested_result)?.label || s.suggested_result}`);
    return bits.length ? bits.join(' · ') : '—';
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="决策总数" value={rows.length} />
        <Stat label="待结果评估" value={pending.length} tone="text-amber-600" />
        <Stat label="未附证据" value={noEvidence.length} tone="text-rose-600" />
        <Stat label="最多原因" value={topReasons[0]?.[1] || 0} tone="text-indigo-600" />
      </div>

      {topReasons.length > 0 && (
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="text-gray-400">重复原因：</span>
          {topReasons.map(([code, n]) => (
            <span key={code} className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
              {REASON_LABEL[code] || code} × {n}
            </span>
          ))}
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-gray-200">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-xs">
            <tr>
              <th className="text-left px-3 py-2 font-medium">时间</th>
              <th className="text-left px-3 py-2 font-medium">物料</th>
              <th className="text-left px-3 py-2 font-medium">动作</th>
              <th className="text-left px-3 py-2 font-medium">原因</th>
              <th className="text-left px-3 py-2 font-medium">改动</th>
              <th className="text-left px-3 py-2 font-medium">状态</th>
              <th className="text-left px-3 py-2 font-medium">结果信号</th>
              <th className="text-left px-3 py-2 font-medium">订单</th>
              {canEvaluate && <th className="px-3 py-2" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.length === 0 && (
              <tr><td colSpan={canEvaluate ? 9 : 8} className="px-3 py-8 text-center text-gray-400">暂无物料决策记录</td></tr>
            )}
            {rows.map(r => {
              const before = r.before_json?.qty_per_piece;
              const after = r.after_json?.qty_per_piece;
              const change = (before != null || after != null) ? `${before ?? '—'} → ${after ?? '—'}` : '—';
              return (
                <tr key={r.id} className="hover:bg-gray-50 align-top">
                  <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">{(r.decided_at || '').slice(0, 10)}</td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-gray-800">{r.material_name}</div>
                    {r.material_code && <div className="text-xs text-gray-400">{r.material_code}</div>}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">{TYPE_LABEL[r.decision_type] || r.decision_type}</td>
                  <td className="px-3 py-2">
                    <div className="text-gray-700">{REASON_LABEL[r.reason_code] || r.reason_code}</div>
                    {r.reason_note && <div className="text-xs text-gray-400 max-w-[16rem] truncate" title={r.reason_note}>{r.reason_note}</div>}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-600 whitespace-nowrap">{change}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${r.status === 'evaluated' ? 'bg-green-100 text-green-700' : r.status === 'superseded' ? 'bg-gray-100 text-gray-500' : 'bg-amber-100 text-amber-700'}`}>
                      {STATUS_LABEL[r.status] || r.status}
                    </span>
                    {r.status === 'evaluated' && (
                      <div className="text-[11px] mt-1 text-gray-500">{r.outcome_was_correct ? '✅ 当初对' : '❌ 当初错'}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-500 max-w-[14rem]">{signalSummary(r)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <Link href={`/orders/${r.order_id}`} className="text-xs text-indigo-600 hover:underline">查看订单</Link>
                  </td>
                  {canEvaluate && (
                    <td className="px-3 py-2 whitespace-nowrap">
                      {(r.status === 'confirmed' || r.status === 'outcome_pending') && (
                        editingId === r.id ? (
                          <div className="space-y-1 min-w-[16rem]">
                            <select value={outcome} onChange={e => setOutcome(e.target.value as OutcomeResult | '')}
                              className="w-full rounded border border-gray-300 px-2 py-1 text-xs">
                              <option value="">— 结果判定 —</option>
                              {OUTCOME_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </select>
                            <div className="flex gap-1 text-xs">
                              <button onClick={() => setWasCorrect('yes')} className={`px-2 py-1 rounded ${wasCorrect === 'yes' ? 'bg-green-600 text-white' : 'bg-gray-100'}`}>当初对</button>
                              <button onClick={() => setWasCorrect('no')} className={`px-2 py-1 rounded ${wasCorrect === 'no' ? 'bg-rose-600 text-white' : 'bg-gray-100'}`}>当初错</button>
                            </div>
                            <input value={cause} onChange={e => setCause(e.target.value)} placeholder="因果归属(可选)"
                              className="w-full rounded border border-gray-300 px-2 py-1 text-xs" />
                            <div className="flex gap-1">
                              <button disabled={busy} onClick={() => submitEval(r.id)} className="px-2 py-1 rounded bg-indigo-600 text-white text-xs disabled:opacity-50">保存</button>
                              <button onClick={() => setEditingId(null)} className="px-2 py-1 rounded bg-gray-100 text-xs">取消</button>
                            </div>
                          </div>
                        ) : (
                          <button onClick={() => { setEditingId(r.id); setOutcome(''); setWasCorrect(''); setCause(''); }}
                            className="text-xs px-2 py-1 rounded bg-amber-500 text-white hover:bg-amber-600">评估</button>
                        )
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-400">
        结果信号由系统只读现有采购数据自动算出（补料 / 超买 / 成本差），仅作提示；「当初对/错」的因果判定必须由人工确认（不把相关性当因果）。
      </p>
    </div>
  );
}
