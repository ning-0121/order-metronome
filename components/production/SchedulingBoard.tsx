'use client';

/**
 * 生产排单工作台(P1)—— 生产主管把待排产的款(个别到色)派给工厂。
 * 每款展开候选工厂:擅长品类/品质/织造/包装/订单类型匹配 + 剩余产能 + 在做单数,主管选厂+排窗口→派工。
 */

import { useEffect, useState } from 'react';
import { getSchedulingBoard, dispatchStyle, setOrderProductionAttrs, updateDispatchStatus } from '@/app/actions/production-scheduling';
import { QUALITY_GRADES, WEAVE_TYPES } from '@/lib/production/scheduling';

const chip = (ok: boolean | null) => ok === null ? <span className="text-gray-300">·</span> : ok ? <span className="text-emerald-600">✓</span> : <span className="text-rose-500">✗</span>;

export function SchedulingBoard() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [openStyle, setOpenStyle] = useState<string>('');   // 展开派工的 key
  const [msg, setMsg] = useState('');

  const load = () => getSchedulingBoard().then((r) => { setData((r as any).data || { orders: [], factories: [] }); setLoading(false); if ((r as any).error) setMsg((r as any).error); });
  useEffect(() => { load(); }, []);

  if (loading) return <div className="text-sm text-gray-400 py-6">加载排产数据…</div>;
  const orders = data?.orders || [];

  async function saveAttr(orderId: string, patch: any) {
    await setOrderProductionAttrs(orderId, patch);
    setData((d: any) => ({ ...d, orders: d.orders.map((o: any) => o.id === orderId ? { ...o, ...patch } : o) }));
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-bold text-gray-800">🏭 排产工作台</h2>
        <span className="text-xs text-gray-500">把款派给工厂:看擅长/剩余产能/在做量,选厂+排窗口。个别可细到单色。</span>
        {msg && <span className="text-xs text-rose-600">{msg}</span>}
      </div>
      {orders.length === 0 ? <p className="text-sm text-gray-400">暂无待排产订单。</p> : orders.map((o: any) => (
        <div key={o.id} className="rounded-xl border border-gray-200 bg-white p-3">
          {/* 订单头 + 要求 */}
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap text-sm">
                <span className="font-semibold text-gray-900">{o.order_no}</span>
                <span className="text-gray-500">{o.customer_name}</span>
                <span className="text-gray-400 truncate">{o.product_description}</span>
                <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">{o.order_capability}</span>
              </div>
              <div className="flex items-center gap-3 mt-1 text-xs text-gray-500 flex-wrap">
                <span>数量 <b className="text-gray-700">{o.quantity ?? '—'}</b></span>
                <span>交期 <b className="text-gray-700">{o.factory_date ? String(o.factory_date).slice(0, 10) : '—'}</b></span>
                <span>原辅料到位 <b className={o.material_ready_pct >= 100 ? 'text-emerald-600' : 'text-amber-600'}>{o.material_ready_pct == null ? '—' : o.material_ready_pct + '%'}</b></span>
              </div>
            </div>
            {/* 手填要求 */}
            <div className="flex items-center gap-2 text-xs">
              <select value={o.quality_grade || ''} onChange={(e) => saveAttr(o.id, { quality_grade: e.target.value || null })} className="rounded border border-gray-300 px-1.5 py-1 bg-white">
                <option value="">品质…</option>{QUALITY_GRADES.map((q) => <option key={q} value={q}>{q}</option>)}
              </select>
              <select value={o.weave_type || ''} onChange={(e) => saveAttr(o.id, { weave_type: e.target.value || null })} className="rounded border border-gray-300 px-1.5 py-1 bg-white">
                <option value="">织造…</option>{WEAVE_TYPES.map((w) => <option key={w} value={w}>{w}</option>)}
              </select>
              <label className="flex items-center gap-1 text-gray-600"><input type="checkbox" checked={!!o.needs_package} onChange={(e) => saveAttr(o.id, { needs_package: e.target.checked })} />要包装</label>
            </div>
          </div>

          {/* 款列表 */}
          <div className="mt-2 space-y-1.5">
            {o.styles.map((s: any) => {
              const key = `${o.id}¦${s.style_no}`;
              const dispatched = (s.dispatches || []).length > 0;
              return (
                <div key={key} className="rounded-lg border border-gray-100 bg-gray-50/60 p-2">
                  <div className="flex items-center gap-2 flex-wrap text-sm">
                    <span className="font-mono text-gray-800">{s.style_no || '(整单)'}</span>
                    <span className="text-gray-500 truncate">{s.product_name}</span>
                    <span className="text-xs text-gray-500">{s.qty} 件 · {s.colors.length} 色</span>
                    {dispatched
                      ? <span className="text-xs text-emerald-700">已派:{s.dispatches.map((d: any) => `${d.factory_name || '?'}${d.color ? `(${d.color})` : ''}`).join('、')}</span>
                      : <span className="text-xs px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700">待排单</span>}
                    <button onClick={() => setOpenStyle(openStyle === key ? '' : key)} className="ml-auto text-xs text-indigo-600 hover:underline">{openStyle === key ? '收起' : (dispatched ? '改派/加色' : '派工')}</button>
                  </div>

                  {openStyle === key && (
                    <DispatchPanel order={o} style={s} candidates={o.candidates} onDone={() => { setOpenStyle(''); load(); }} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function DispatchPanel({ order, style, candidates, onDone }: { order: any; style: any; candidates: any[]; onDone: () => void }) {
  const [factoryId, setFactoryId] = useState(candidates[0]?.factory_id || '');
  const [color, setColor] = useState('');   // 空=整款
  const [qty, setQty] = useState<string>(String(style.qty || ''));
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit() {
    if (!factoryId) { setErr('请选工厂'); return; }
    setBusy(true); setErr('');
    const r = await dispatchStyle({ orderId: order.id, styleNo: style.style_no, color: color || null, factoryId, plannedQty: qty ? Number(qty) : null, start: start || null, end: end || null });
    setBusy(false);
    if ((r as any).error) setErr((r as any).error); else onDone();
  }

  return (
    <div className="mt-2 rounded-lg bg-white border border-indigo-100 p-2 space-y-2">
      {/* 候选工厂对照 */}
      <div className="overflow-x-auto">
        <table className="text-[11px] w-full">
          <thead><tr className="text-gray-400 text-left border-b border-gray-100">
            {['选', '工厂', '品类', '品质', '织造', '包装', '类型', '月产能', '剩余', '在做'].map((h) => <th key={h} className="px-1.5 py-1 whitespace-nowrap font-medium">{h}</th>)}
          </tr></thead>
          <tbody>
            {candidates.map((c: any) => (
              <tr key={c.factory_id} className={`border-b border-gray-50 cursor-pointer ${factoryId === c.factory_id ? 'bg-indigo-50' : ''} ${c.match.hardMiss > 0 ? 'opacity-60' : ''}`} onClick={() => setFactoryId(c.factory_id)}>
                <td className="px-1.5 py-1"><input type="radio" checked={factoryId === c.factory_id} onChange={() => setFactoryId(c.factory_id)} /></td>
                <td className="px-1.5 py-1 font-medium text-gray-800 whitespace-nowrap">{c.factory_name}{c.match.allOk && <span className="ml-1 text-emerald-600">★</span>}</td>
                <td className="px-1.5 py-1 text-center" title={(c.product_categories || []).join('、')}>{chip(c.match.category)}</td>
                <td className="px-1.5 py-1 text-center">{chip(c.match.quality)}</td>
                <td className="px-1.5 py-1 text-center">{chip(c.match.weave)}</td>
                <td className="px-1.5 py-1 text-center">{chip(c.match.packaging)}</td>
                <td className="px-1.5 py-1 text-center">{chip(c.match.orderType)}</td>
                <td className="px-1.5 py-1 text-right">{c.monthly_capacity ?? '—'}</td>
                <td className={`px-1.5 py-1 text-right font-semibold ${c.remaining != null && c.remaining < 0 ? 'text-rose-600' : 'text-gray-700'}`}>{c.remaining ?? '—'}</td>
                <td className="px-1.5 py-1 text-center">{c.active_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* 派工参数 */}
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <select value={color} onChange={(e) => setColor(e.target.value)} className="rounded border border-gray-300 px-1.5 py-1 bg-white" title="留空=整款派;选颜色=只派该色">
          <option value="">整款</option>{style.colors.map((c: string) => <option key={c} value={c}>只派 {c}</option>)}
        </select>
        <input type="number" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="件数" className="rounded border border-gray-300 px-2 py-1 w-20 text-right" />
        <span className="text-gray-400">排产</span>
        <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="rounded border border-gray-300 px-1.5 py-1" />
        <span className="text-gray-400">至</span>
        <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="rounded border border-gray-300 px-1.5 py-1" />
        <button onClick={submit} disabled={busy} className="px-3 py-1 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50">{busy ? '派工中…' : '✅ 派工'}</button>
        {err && <span className="text-rose-600">{err}</span>}
      </div>
      {/* 已派的可改状态 */}
      {(style.dispatches || []).length > 0 && (
        <div className="text-[11px] text-gray-500 space-y-1">
          {style.dispatches.map((d: any) => (
            <div key={d.id} className="flex items-center gap-2">
              <span>📌 {d.factory_name}{d.color ? `(${d.color})` : ''} · {d.planned_qty || '—'}件 · {d.status === 'scheduled' ? '已排' : d.status === 'in_production' ? '生产中' : d.status}</span>
              {d.status === 'scheduled' && <button onClick={() => updateDispatchStatus(d.id, 'in_production').then(onDone)} className="text-indigo-600 hover:underline">标生产中</button>}
              {d.status !== 'cancelled' && <button onClick={() => updateDispatchStatus(d.id, 'cancelled').then(onDone)} className="text-rose-500 hover:underline">撤销</button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
