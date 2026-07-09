'use client';

// 批量进度校准(2026-07-09 用户):一屏列出所有活单,逐单选"实际到了哪个节点"→ 之前标完成清风险。
// 系统按"首个未完成节点"预选当前节点,通常直接确认即可。仅 admin/生产主管。
import { useEffect, useState } from 'react';
import { listOrdersForCalibration, calibrateOrderStage } from '@/app/actions/order-progress-calibrate';

type Row = Awaited<ReturnType<typeof listOrdersForCalibration>>['data'] extends (infer T)[] ? T : any;

export function CalibrateClient() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [pick, setPick] = useState<Record<string, string>>({});     // order_id → 选中的 step_key
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [doneMsg, setDoneMsg] = useState<Record<string, string>>({});

  async function load() {
    setLoading(true);
    const r = await listOrdersForCalibration();
    if ((r as any).error) { setErr((r as any).error); setLoading(false); return; }
    const data = ((r as any).data || []) as Row[];
    setRows(data);
    setPick(Object.fromEntries(data.map((o: any) => [o.order_id, o.current_hint])));   // 预选首个未完成节点
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  async function apply(o: any) {
    const stepKey = pick[o.order_id];
    if (!stepKey) return;
    setBusy(b => ({ ...b, [o.order_id]: true })); setDoneMsg(m => ({ ...m, [o.order_id]: '' }));
    const r = await calibrateOrderStage(o.order_id, stepKey);
    setBusy(b => ({ ...b, [o.order_id]: false }));
    if ((r as any).error) { setDoneMsg(m => ({ ...m, [o.order_id]: '❌ ' + (r as any).error })); return; }
    setDoneMsg(m => ({ ...m, [o.order_id]: `✅ 已校准(标完成 ${(r as any).done} 个之前节点)` }));
  }

  if (loading) return <div className="text-center py-10 text-gray-400 text-sm">加载活单…</div>;
  if (err) return <div className="rounded-lg bg-rose-50 text-rose-700 px-4 py-3 text-sm">{err}</div>;
  if (rows.length === 0) return <div className="text-center py-10 text-gray-400 text-sm">没有需要校准的活单。</div>;

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-500">
        每单选「实际到了哪个节点」→ 点「校准」:该节点之前的里程碑全标已完成(逾期风险消失)、该节点设进行中。
        下拉已按「首个未完成节点」预选,大多直接点校准即可。只影响所选之前的节点,不改出厂日。
      </p>
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead><tr className="bg-gray-50 text-left text-gray-500 text-xs">
            {['订单号', '客户', '出厂日', '进度', '实际到了哪个节点', '', '结果'].map(h => <th key={h} className="px-3 py-2 font-medium whitespace-nowrap">{h}</th>)}
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((o: any) => (
              <tr key={o.order_id} className={doneMsg[o.order_id]?.startsWith('✅') ? 'bg-emerald-50/40' : ''}>
                <td className="px-3 py-2 font-mono text-gray-800 whitespace-nowrap">{o.order_no || '—'}</td>
                <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{o.customer_name || '—'}</td>
                <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{o.factory_date || '—'}</td>
                <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{o.done_count}/{o.total}</td>
                <td className="px-3 py-2">
                  <select value={pick[o.order_id] ?? ''} onChange={e => setPick(p => ({ ...p, [o.order_id]: e.target.value }))}
                    className="text-sm border border-gray-300 rounded-lg px-2 py-1 bg-white max-w-[220px]">
                    <option value="">选节点…</option>
                    {o.steps.map((s: any) => <option key={s.step_key} value={s.step_key}>{s.name}{['done', '已完成', 'completed'].includes(s.status) ? '（已完成）' : ''}</option>)}
                  </select>
                </td>
                <td className="px-3 py-2">
                  <button onClick={() => apply(o)} disabled={busy[o.order_id] || !pick[o.order_id]}
                    className="text-xs px-3 py-1.5 rounded-lg bg-amber-600 text-white font-medium hover:bg-amber-700 disabled:opacity-50 whitespace-nowrap">
                    {busy[o.order_id] ? '校准中…' : '校准'}
                  </button>
                </td>
                <td className="px-3 py-2 text-xs text-gray-600 whitespace-nowrap">{doneMsg[o.order_id] || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
