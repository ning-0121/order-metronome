'use client';

/**
 * 生产排单工作台(P1)—— 生产主管把待排产的款(个别到色)派给工厂。
 * 每款展开候选工厂:擅长品类/品质/织造/包装/订单类型匹配 + 剩余产能 + 在做单数,主管选厂+排窗口→派工。
 */

import { useEffect, useState } from 'react';
import { getSchedulingBoard, dispatchStyle, setOrderProductionAttrs, updateDispatchStatus, assignProductionDispatch } from '@/app/actions/production-scheduling';
import { getMerchandiserCandidates } from '@/app/actions/commissions';
import { QUALITY_GRADES, WEAVE_TYPES } from '@/lib/production/scheduling';

const chip = (ok: boolean | null) => ok === null ? <span className="text-gray-300">·</span> : ok ? <span className="text-emerald-600">✓</span> : <span className="text-rose-500">✗</span>;

export function SchedulingBoard() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [openStyle, setOpenStyle] = useState<string>('');   // 展开派工的 key
  const [msg, setMsg] = useState('');
  const [orderSearch, setOrderSearch] = useState('');
  const [productionCandidates, setProductionCandidates] = useState<any[]>([]);

  const load = async () => {
    const [board, candidates] = await Promise.all([
      getSchedulingBoard(),
      getMerchandiserCandidates('production'),
    ]);
    setData((board as any).data || { orders: [], factories: [], queue: [], queue_summary: {} });
    setProductionCandidates((candidates as any).data || []);
    setLoading(false);
    if ((board as any).error) setMsg((board as any).error);
  };
  useEffect(() => { load(); }, []);

  if (loading) return <div className="text-sm text-gray-400 py-6">加载排产数据…</div>;
  const orders = data?.orders || [];
  const queue = data?.queue || [];
  const queueSummary = data?.queue_summary || {};
  const q = orderSearch.trim().toLowerCase();
  const visibleOrders = !q ? orders : orders.filter((o: any) => [o.order_no, o.internal_order_no, o.po_number, o.style_no, o.customer_name]
    .some((value) => String(value || '').toLowerCase().includes(q)));
  const visibleQueue = !q ? queue : queue.filter((o: any) => [o.order_no, o.internal_order_no, o.po_number, o.style_no, o.customer_name, o.factory_name, o.production_follow_up_name]
    .some((value) => String(value || '').toLowerCase().includes(q)));

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
      <input value={orderSearch} onChange={(e) => setOrderSearch(e.target.value)} placeholder="搜索 QM 单号、内部单号、客户 PO、款号或客户"
        className="w-full max-w-md rounded-lg border border-gray-300 px-3 py-2 text-sm" />
      {(queueSummary?.total || 0) > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-xs text-amber-900">
            <span className="font-semibold">未派单总数 {queueSummary.total || 0}</span>
            <span>未定工厂 {queueSummary.missing_factory || 0}</span>
            <span>未派跟单 {queueSummary.missing_follow_up || 0}</span>
            <span>两项均未完成 {queueSummary.both_missing || 0}</span>
          </div>
          <div className="space-y-2">
            {visibleQueue.map((o: any) => (
              <UnassignedDispatchCard
                key={o.id}
                order={o}
                factories={data?.factories || []}
                candidates={productionCandidates}
                onDone={() => { setOpenStyle(''); load(); }}
              />
            ))}
            {visibleQueue.length === 0 && <p className="text-xs text-amber-800">没有匹配的未派单订单。</p>}
          </div>
        </div>
      )}
      {visibleOrders.length === 0 ? <p className="text-sm text-gray-400">{orders.length ? '没有匹配的排产订单。' : '暂无待排产订单。'}</p> : visibleOrders.map((o: any) => (
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
                <span>内部单号 <b className="text-gray-700">{o.internal_order_no || '—'}</b></span>
                <span>客户PO <b className="text-gray-700">{o.po_number || '—'}</b></span>
                <span>款号 <b className="text-gray-700">{o.style_no || '—'}</b></span>
                <span>件数 <b className="text-gray-700">{o.piece_count ?? o.quantity ?? '—'}</b></span>
                <span>款数 <b className="text-gray-700">{o.style_count ?? '—'}</b></span>
                <span>颜色 <b className="text-gray-700">{o.color_label || '颜色待补'}</b></span>
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
                    {s.image_url
                      ? <img src={s.image_url} alt="" loading="lazy" className="w-9 h-9 rounded object-cover border border-gray-200 bg-white shrink-0" />
                      : <span className="w-9 h-9 rounded border border-dashed border-gray-200 flex items-center justify-center text-gray-300 text-xs shrink-0">图</span>}
                    <span className="font-mono text-gray-800">{s.style_no || '(整单)'}</span>
                    <span className="text-gray-500 truncate">{s.product_name}</span>
                    <span className="text-xs text-gray-500">{s.qty} 件 · {s.color_label || `${s.colors.length || 0} 色`}</span>
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

function UnassignedDispatchCard({
  order,
  factories,
  candidates,
  onDone,
}: {
  order: any;
  factories: any[];
  candidates: any[];
  onDone: () => void;
}) {
  const [factoryId, setFactoryId] = useState(order.factory_id || '');
  const [followUpId, setFollowUpId] = useState(order.production_follow_up_id || '');
  const [reason, setReason] = useState(`生产派单：${order.order_no || order.internal_order_no || ''}`.trim());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const statusLabel = order.dispatch_status === 'both_missing'
    ? '未定工厂 / 未派跟单'
    : order.dispatch_status === 'missing_factory'
      ? '未定工厂'
      : '未派跟单';

  async function submit() {
    setBusy(true);
    setErr('');
    const res = await assignProductionDispatch({
      orderId: order.id,
      factoryId: factoryId || null,
      productionFollowUpId: followUpId || null,
      reason,
    });
    setBusy(false);
    if ((res as any).error) {
      setErr((res as any).error);
      return;
    }
    onDone();
  }

  return (
    <div className="rounded-lg border border-amber-200 bg-white p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-semibold text-gray-900">{order.order_no}</span>
            <span className="text-gray-500">{order.customer_name}</span>
            <span className="text-xs rounded-full bg-amber-100 px-2 py-0.5 text-amber-700">{statusLabel}</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-3 text-xs text-gray-500">
            <span>内部单号 <b className="text-gray-700">{order.internal_order_no || '—'}</b></span>
            <span>客户PO <b className="text-gray-700">{order.po_number || '—'}</b></span>
            <span>款号 <b className="text-gray-700">{order.style_no || '—'}</b></span>
            <span>数量 <b className="text-gray-700">{order.quantity ?? '—'}</b></span>
            <span>交期 <b className="text-gray-700">{order.factory_date || '—'}</b></span>
            <span>当前工厂 <b className="text-gray-700">{order.factory_name || '—'}</b></span>
            <span>当前跟单 <b className="text-gray-700">{order.production_follow_up_name || '—'}</b></span>
          </div>
        </div>
        <div className="text-xs text-gray-500">原辅料到位 {order.material_ready_pct == null ? '—' : `${order.material_ready_pct}%`}</div>
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-[1fr_1fr_1.2fr_auto]">
        <select value={factoryId} onChange={(e) => setFactoryId(e.target.value)} className="rounded border border-gray-300 px-2 py-1.5 text-sm bg-white">
          <option value="">选择工厂</option>
          {factories.map((f: any) => (
            <option key={f.id} value={f.id}>{f.factory_name}{f.factory_code ? ` (${f.factory_code})` : ''}</option>
          ))}
        </select>
        <select value={followUpId} onChange={(e) => setFollowUpId(e.target.value)} className="rounded border border-gray-300 px-2 py-1.5 text-sm bg-white">
          <option value="">选择生产跟单</option>
          {candidates.map((c: any) => (
            <option key={c.user_id} value={c.user_id}>{c.name || c.email || c.user_id}</option>
          ))}
        </select>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="rounded border border-gray-300 px-3 py-1.5 text-sm"
          placeholder="派单原因"
        />
        <button
          type="button"
          disabled={busy}
          onClick={submit}
          className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
        >
          {busy ? '派单中…' : '确认派单'}
        </button>
      </div>
      {err && <div className="mt-2 text-xs text-rose-600">{err}</div>}
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
  const [overbook, setOverbook] = useState<any[] | null>(null);   // 超卖详情,非空=需强制确认
  const [factorySearch, setFactorySearch] = useState('');
  const selected = candidates.find((c: any) => c.factory_id === factoryId);
  const visibleCandidates = candidates.filter((c: any) => `${c.factory_name || ''} ${c.factory_code || ''}`.toLowerCase().includes(factorySearch.trim().toLowerCase()));

  async function submit(force = false) {
    if (!factoryId) { setErr('请选工厂'); return; }
    setBusy(true); setErr(''); if (force) setOverbook(null);
    const r = await dispatchStyle({ orderId: order.id, styleNo: style.style_no, color: color || null, factoryId, plannedQty: qty ? Number(qty) : null, start: start || null, end: end || null, force });
    setBusy(false);
    if ((r as any).overbook && !force) { setOverbook((r as any).overbook); setErr((r as any).error || ''); return; }
    if ((r as any).error) setErr((r as any).error); else onDone();
  }

  return (
    <div className="mt-2 rounded-lg bg-white border border-indigo-100 p-2 space-y-2">
      {/* 候选工厂对照 */}
      <input value={factorySearch} onChange={(e) => setFactorySearch(e.target.value)} placeholder={`搜索全部 ${candidates.length} 家可用工厂`}
        className="w-full max-w-xs rounded border border-gray-300 px-2 py-1 text-xs" />
      <div className="overflow-x-auto">
        <table className="text-[11px] w-full">
          <thead><tr className="text-gray-400 text-left border-b border-gray-100">
            {['选', '工厂', '状态', '品类', '品质', '织造', '包装', '类型', '月产能', '剩余', '在做'].map((h) => <th key={h} className="px-1.5 py-1 whitespace-nowrap font-medium">{h}</th>)}
          </tr></thead>
          <tbody>
            {visibleCandidates.map((c: any) => (
              <tr key={c.factory_id} className={`border-b border-gray-50 cursor-pointer ${factoryId === c.factory_id ? 'bg-indigo-50' : ''} ${c.match.hardMiss > 0 ? 'opacity-60' : ''}`} onClick={() => setFactoryId(c.factory_id)}>
                <td className="px-1.5 py-1"><input type="radio" checked={factoryId === c.factory_id} onChange={() => setFactoryId(c.factory_id)} /></td>
                <td className="px-1.5 py-1 font-medium text-gray-800 whitespace-nowrap">{c.factory_name}{c.factory_code ? ` (${c.factory_code})` : ''}</td>
                <td className="px-1.5 py-1 whitespace-nowrap"><span className={c.recommendation === '推荐' ? 'text-emerald-600' : 'text-amber-600'}>{c.recommendation}</span></td>
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
        <button onClick={() => submit(false)} disabled={busy} className="px-3 py-1 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50">{busy ? '派工中…' : '✅ 派工'}</button>
        {err && !overbook && <span className="text-rose-600">{err}</span>}
      </div>

      {/* 选中工厂的按月产能账 */}
      {selected?.ledger?.length > 0 && (
        <div className="flex items-center gap-3 text-[11px] text-gray-500 flex-wrap">
          <span className="text-gray-400">{selected.factory_name} 产能账:</span>
          {selected.ledger.map((m: any) => (
            <span key={m.month} className={m.remaining != null && m.remaining < 0 ? 'text-rose-600 font-medium' : ''}>
              {m.month.slice(5)}月 {m.committed}/{m.capacity ?? '—'}{m.remaining != null && <span className="text-gray-400">(剩{m.remaining})</span>}
            </span>
          ))}
        </div>
      )}

      {/* 超卖拦截:显示详情 + 强制派工 */}
      {overbook && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-2 text-[11px] space-y-1">
          <p className="text-rose-700 font-medium">⚠️ 产能超卖,拦下了:</p>
          {overbook.filter((d: any) => d.over).map((d: any) => (
            <p key={d.month} className="text-rose-600">{d.month}:已派 {d.committed} + 本单 {d.add} = {d.after} &gt; 月产能 {d.capacity}</p>
          ))}
          <div className="flex items-center gap-2 pt-1">
            <button onClick={() => submit(true)} disabled={busy} className="px-2.5 py-1 rounded bg-rose-600 text-white font-medium hover:bg-rose-700 disabled:opacity-50">仍派工(强制)</button>
            <span className="text-gray-500">或改期/换厂</span>
          </div>
        </div>
      )}
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
