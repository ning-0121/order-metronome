'use client';

import { useState } from 'react';
import { parseProductionDailyReport, applyProductionDailyReport, type DailyReportPreviewRow } from '@/app/actions/production-daily-report';

const STATUS_ICON: Record<string, string> = { '完成': '✅', '进行中': '🔧', '受阻': '🚧', '待跟进': '👀' };

export function DailyReportClient() {
  const [text, setText] = useState('');
  const [rows, setRows] = useState<DailyReportPreviewRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  // 人可改的两个东西:每行订单(不确定的)+ 是否勾"标节点完成"
  const [overrideOrder, setOverrideOrder] = useState<Record<number, string>>({});
  const [completeChecks, setCompleteChecks] = useState<Record<number, boolean>>({});

  async function doParse() {
    setBusy(true); setErr(''); setMsg(''); setRows(null);
    const res = await parseProductionDailyReport(text);
    setBusy(false);
    if (res.error) { setErr(res.error); return; }
    const r = res.rows || [];
    setRows(r);
    // 默认勾:后端建议标节点的行
    const checks: Record<number, boolean> = {};
    r.forEach((row, i) => { if (row.suggestCompleteNode) checks[i] = true; });
    setCompleteChecks(checks);
    setOverrideOrder({});
  }

  async function doApply() {
    if (!rows) return;
    setBusy(true); setErr(''); setMsg('');
    const applyRows = rows.map((row, i) => {
      const orderId = overrideOrder[i] || row.orderId;
      return orderId ? {
        orderId,
        process: row.process, status: row.status, date: row.date, note: row.note, category: row.category,
        milestoneId: row.milestoneId, completeNode: !!completeChecks[i] && row.nodeHow === 'unique',
      } : null;
    }).filter(Boolean) as any[];
    const res = await applyProductionDailyReport(applyRows);
    setBusy(false);
    if (res.error) { setErr(res.error); return; }
    const s = res.summary!;
    setMsg(`已写入 ${s.notes} 条生产动态${s.nodesCompleted ? `,标完成 ${s.nodesCompleted} 个节点` : ''}${s.skipped ? `,跳过 ${s.skipped} 条(订单没对上)` : ''}。`
      + (s.nodeErrors.length ? ` ⚠️ ${s.nodeErrors.length} 条有问题:${s.nodeErrors.slice(0, 3).join(';')}` : ''));
    setRows(null); setText('');
  }

  const matchedCount = rows?.filter((r) => r.orderId || overrideOrder[rows.indexOf(r)]).length ?? 0;
  const problemCount = rows?.filter((r, i) => !(r.orderId || overrideOrder[i])).length ?? 0;

  return (
    <div className="space-y-4">
      <textarea
        value={text} onChange={(e) => setText(e.target.value)} rows={10}
        placeholder="把群里的日报整段粘到这里…（可以一次粘多个人的）"
        className="w-full text-sm border border-gray-300 rounded-xl px-3 py-2 font-mono"
      />
      <div className="flex items-center gap-3">
        <button onClick={doParse} disabled={busy || !text.trim()}
          className="text-sm px-4 py-2 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50">
          {busy ? '处理中…' : '解析'}
        </button>
        {rows && (
          <button onClick={doApply} disabled={busy || matchedCount === 0}
            className="text-sm px-4 py-2 rounded-lg bg-green-600 text-white font-medium hover:bg-green-700 disabled:opacity-50">
            确认应用({matchedCount} 条){problemCount ? ` · ${problemCount} 条待处理` : ''}
          </button>
        )}
      </div>

      {err && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{err}</p>}
      {msg && <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">{msg}</p>}

      {rows && (
        <div className="rounded-xl border border-gray-200 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-gray-500">
              <tr>
                <th className="text-left px-3 py-2">订单</th>
                <th className="text-left px-3 py-2">工序/状态</th>
                <th className="text-left px-3 py-2">说明</th>
                <th className="text-left px-3 py-2">动作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r, i) => {
                const resolvedOrder = overrideOrder[i] || r.orderId;
                const hasProblem = !resolvedOrder;
                return (
                  <tr key={i} className={hasProblem ? 'bg-amber-50' : ''}>
                    <td className="px-3 py-2 align-top">
                      {r.orderId ? (
                        <span className="font-medium text-gray-800">{r.matchedNo}
                          <span className="text-gray-400 ml-1">({r.orderHow === 'suffix-internal' ? '短号' : r.orderHow === 'exact-orderno' ? '单号' : '精确'})</span>
                        </span>
                      ) : r.orderCandidates.length > 0 ? (
                        <select value={overrideOrder[i] || ''} onChange={(e) => setOverrideOrder((m) => ({ ...m, [i]: e.target.value }))}
                          className="text-xs border rounded px-1 py-1 max-w-40">
                          <option value="">选订单…({r.orderToken})</option>
                          {r.orderCandidates.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                        </select>
                      ) : (
                        <span className="text-amber-700">⚠️ {r.orderToken || '无号'}<div className="text-[10px] text-amber-600">{r.problem}</div></span>
                      )}
                    </td>
                    <td className="px-3 py-2 align-top whitespace-nowrap">
                      {r.status && STATUS_ICON[r.status]} {r.process || '—'}
                      {r.status && <span className="text-gray-400"> / {r.status}</span>}
                      {r.date && <span className="text-gray-400"> / {r.date}</span>}
                    </td>
                    <td className="px-3 py-2 align-top text-gray-700 max-w-xs">{r.note}</td>
                    <td className="px-3 py-2 align-top whitespace-nowrap">
                      {!resolvedOrder ? <span className="text-amber-600">先选订单</span> : (
                        <>
                          <span className="text-gray-500">记动态</span>
                          {r.status === '完成' && r.nodeHow === 'unique' && (
                            <label className="flex items-center gap-1 mt-1 text-indigo-700">
                              <input type="checkbox" checked={!!completeChecks[i]} onChange={(e) => setCompleteChecks((m) => ({ ...m, [i]: e.target.checked }))} />
                              标完成:{r.milestoneName}
                            </label>
                          )}
                          {r.status === '完成' && r.nodeHow === 'already-done' && <div className="text-[10px] text-gray-400 mt-1">{r.milestoneName} 已完成</div>}
                          {r.status === '完成' && r.nodeHow === 'none' && <div className="text-[10px] text-gray-400 mt-1">无对应节点</div>}
                          {r.category === 'delay' && <div className="text-[10px] text-red-500 mt-1">🚧 记为风险</div>}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
