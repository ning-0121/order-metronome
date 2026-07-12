'use client';

/**
 * 生产进度看板(P4)—— 跟单/QC 每天录当日实际产出,对照派工计划看进度。
 * 派工=计划(planned_qty),这里=实绩(累计完成)。落后/准时一眼看清;录错补负数修正。
 * 录入:生产/跟单/QC/主管;标完工:仅主管/admin(canManage)。
 */

import { useEffect, useState } from 'react';
import { getProgressBoard, logDispatchProgress, updateDispatchStatus } from '@/app/actions/production-scheduling';

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 按排产窗口线性估算「到今天应完成」,判断落后。窗口缺/未开始 → 不判。 */
function schedule(planned: number, start?: string | null, end?: string | null): { expected: number | null; behind: boolean } {
  if (!planned || !start || !end) return { expected: null, behind: false };
  const s = new Date(`${String(start).slice(0, 10)}T00:00:00`).getTime();
  const e = new Date(`${String(end).slice(0, 10)}T00:00:00`).getTime();
  const now = Date.now();
  if (isNaN(s) || isNaN(e) || e <= s) return { expected: null, behind: false };
  if (now < s) return { expected: 0, behind: false };
  const ratio = now >= e ? 1 : (now - s) / (e - s);
  return { expected: Math.round(planned * ratio), behind: false };
}

export function ProductionProgressBoard({ canManage }: { canManage: boolean }) {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [openId, setOpenId] = useState('');

  const load = () => getProgressBoard().then((r) => { setItems((r as any).data?.items || []); setLoading(false); if ((r as any).error) setMsg((r as any).error); });
  useEffect(() => { load(); }, []);

  if (loading) return <div className="text-sm text-gray-400 py-6">加载生产进度…</div>;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-bold text-gray-800">📈 生产进度录入</h2>
        <span className="text-xs text-gray-500">跟单/QC 每天录当日产出,对照派工计划看进度。录错补负数修正。</span>
        {msg && <span className="text-xs text-rose-600">{msg}</span>}
      </div>
      {items.length === 0 ? <p className="text-sm text-gray-400">暂无在产派工。派工投产后出现在这里。</p> : (
        <div className="space-y-1.5">
          {items.map((it: any) => {
            const planned = Number(it.planned_qty) || 0;
            const done = Number(it.done_qty) || 0;
            const pct = planned ? Math.min(100, Math.round((done / planned) * 100)) : 0;
            const { expected } = schedule(planned, it.planned_start, it.planned_end);
            const behind = expected != null && done < expected * 0.9 && done < planned;
            const finished = planned > 0 && done >= planned;
            return (
              <div key={it.id} className={`rounded-lg border bg-white p-2.5 ${behind ? 'border-amber-200' : finished ? 'border-emerald-200' : 'border-gray-100'}`}>
                <div className="flex items-center gap-2 flex-wrap text-sm">
                  <span className="font-mono text-gray-800">{it.order?.internal_order_no || it.order?.order_no || '—'}</span>
                  <span className="font-mono text-gray-700">{it.style_no || '(整单)'}</span>
                  {it.color && <span className="text-xs text-gray-500">{it.color}</span>}
                  <span className="text-xs text-gray-400">{it.factory_name || '?'}</span>
                  <span className="text-xs text-gray-400">交期 {it.order?.factory_date ? String(it.order.factory_date).slice(5, 10) : '—'}</span>
                  {behind && <span className="text-xs px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700">落后</span>}
                  {finished && <span className="text-xs px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700">已达量</span>}
                  <button onClick={() => setOpenId(openId === it.id ? '' : it.id)} className="ml-auto text-xs text-indigo-600 hover:underline">{openId === it.id ? '收起' : '录产出'}</button>
                </div>
                {/* 进度条:计划 vs 累计完成,期望位置标线 */}
                <div className="mt-1.5 flex items-center gap-2">
                  <div className="relative flex-1 h-2 rounded-full bg-gray-200 overflow-hidden">
                    <div className={finished ? 'h-full bg-emerald-500' : behind ? 'h-full bg-amber-500' : 'h-full bg-indigo-500'} style={{ width: `${pct}%` }} />
                    {expected != null && planned > 0 && (
                      <div className="absolute top-0 bottom-0 w-px bg-gray-500/70" style={{ left: `${Math.min(100, Math.round((expected / planned) * 100))}%` }} title={`到今天应完成约 ${expected}`} />
                    )}
                  </div>
                  <span className="text-xs text-gray-600 whitespace-nowrap"><b className={finished ? 'text-emerald-600' : behind ? 'text-amber-600' : 'text-indigo-600'}>{done}</b>/{planned || '—'} 件 {planned ? `(${pct}%)` : ''}</span>
                </div>
                {it.recent_logs?.length > 0 && (
                  <div className="mt-1 text-[11px] text-gray-400 flex flex-wrap gap-x-3">
                    {it.recent_logs.map((l: any, i: number) => (
                      <span key={i}>{String(l.log_date).slice(5)}: {l.qty_done > 0 ? '+' : ''}{l.qty_done}{l.note ? ` (${l.note})` : ''}</span>
                    ))}
                  </div>
                )}
                {openId === it.id && (
                  <LogRow dispatchId={it.id} finished={finished} canManage={canManage} onDone={() => { setOpenId(''); load(); }} />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function LogRow({ dispatchId, finished, canManage, onDone }: { dispatchId: string; finished: boolean; canManage: boolean; onDone: () => void }) {
  const [date, setDate] = useState(todayStr());
  const [qty, setQty] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit() {
    if (!qty) { setErr('请填件数'); return; }
    setBusy(true); setErr('');
    const r = await logDispatchProgress({ dispatchId, logDate: date, qtyDone: Number(qty), note: note || null });
    setBusy(false);
    if ((r as any).error) setErr((r as any).error); else onDone();
  }
  async function markDone() {
    setBusy(true); setErr('');
    const r = await updateDispatchStatus(dispatchId, 'done');
    setBusy(false);
    if ((r as any).error) setErr((r as any).error); else onDone();
  }

  return (
    <div className="mt-2 rounded-lg bg-gray-50 border border-gray-100 p-2 flex items-center gap-2 flex-wrap text-xs">
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="rounded border border-gray-300 px-1.5 py-1" />
      <input type="number" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="当日完成件数" className="rounded border border-gray-300 px-2 py-1 w-32 text-right" title="当日增量;录错补负数修正" />
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="备注(可选)" className="rounded border border-gray-300 px-2 py-1 flex-1 min-w-[100px]" />
      <button onClick={submit} disabled={busy} className="px-3 py-1 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50">{busy ? '录入中…' : '录入'}</button>
      {canManage && finished && <button onClick={markDone} disabled={busy} className="px-2.5 py-1 rounded-lg bg-emerald-600 text-white font-medium hover:bg-emerald-700 disabled:opacity-50">标完工</button>}
      {err && <span className="text-rose-600">{err}</span>}
    </div>
  );
}
