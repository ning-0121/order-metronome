'use client';

/** 出车行程看板:建行程(选日期+工厂)、看别人的行程、挂捎带请求、按地址一键导航(高德/百度)。 */

import { useState } from 'react';
import { createTrip, cancelTrip, addPiggyback, updatePiggyback, type TripsBoard, type TripFactory } from '@/app/actions/factory-trips';

const amapLink = (addr: string) => `https://www.amap.com/search?query=${encodeURIComponent(addr)}`;
const baiduLink = (addr: string) => `https://map.baidu.com/search/${encodeURIComponent(addr)}`;

export function TripsBoardClient({ board }: { board: TripsBoard }) {
  const { allFactories, dueFactories } = board;
  const [date, setDate] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const facById = new Map(allFactories.map((f) => [f.id, f]));
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  async function submit() {
    setBusy(true); setMsg('');
    const r = await createTrip(date, picked, note);
    setBusy(false);
    if (!r.ok) { setMsg(r.error || '建行程失败'); return; }
    setPicked([]); setNote(''); location.reload();
  }

  const pickedFacs = picked.map((id) => facById.get(id)).filter(Boolean) as TripFactory[];
  const allAddrs = pickedFacs.map((f) => f.address || f.name).join('\n');

  return (
    <div className="space-y-6">
      {/* 建行程 */}
      <section className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-4">
        <h2 className="text-sm font-semibold text-indigo-900 mb-2">🚗 新建出车行程</h2>
        {dueFactories.length > 0 && (
          <div className="mb-3">
            <div className="text-xs text-gray-500 mb-1">未来两周有到期节点、建议去跑的工厂(点选加入):</div>
            <div className="flex flex-wrap gap-1.5">
              {dueFactories.map((d) => {
                const f = d.factory_id ? facById.get(d.factory_id) : allFactories.find((x) => x.name === d.factory_name);
                if (!f) return <span key={d.factory_name} className="text-[11px] px-2 py-1 rounded-full bg-gray-100 text-gray-400">{d.factory_name}·{d.nodeCount}节点(无档案)</span>;
                const on = picked.includes(f.id);
                return (
                  <button key={f.id} onClick={() => toggle(f.id)}
                    className={`text-[11px] px-2 py-1 rounded-full border ${on ? 'bg-indigo-600 text-white border-indigo-600' : 'border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100'}`}>
                    {f.name} · {d.nodeCount}节点 · 最近{d.nearestDue?.slice(5)}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="备注(可选)" className="flex-1 min-w-[160px] rounded-lg border border-gray-300 px-3 py-1.5 text-sm" />
          <button onClick={submit} disabled={busy || !date || picked.length === 0}
            className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
            {busy ? '…' : '建行程'}
          </button>
        </div>
        {/* 全部工厂多选 */}
        <details className="text-xs text-gray-500">
          <summary className="cursor-pointer">全部工厂选择({picked.length} 已选)</summary>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {allFactories.map((f) => (
              <button key={f.id} onClick={() => toggle(f.id)}
                className={`text-[11px] px-2 py-1 rounded-full border ${picked.includes(f.id) ? 'bg-indigo-600 text-white border-indigo-600' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}>
                {f.name}{!f.address && ' ⚠无地址'}
              </button>
            ))}
          </div>
        </details>
        {pickedFacs.length > 0 && (
          <div className="mt-2 text-[11px] text-gray-500">
            已选 {pickedFacs.length} 家 · <button onClick={() => navigator.clipboard?.writeText(allAddrs)} className="text-indigo-600 hover:underline">复制全部地址</button>(粘到地图 App 规划路线)
          </div>
        )}
        {msg && <p className="mt-1 text-xs text-red-600">{msg}</p>}
      </section>

      {/* 行程列表 */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-900">📋 出车行程(团队共享 · 可挂捎带)</h2>
        {board.trips.length === 0 ? (
          <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-gray-400">还没有行程。上面建一个。</div>
        ) : (
          board.trips.map((t) => <TripCard key={t.id} trip={t} />)
        )}
      </section>
    </div>
  );
}

function TripCard({ trip }: { trip: TripsBoard['trips'][number] }) {
  const [showPb, setShowPb] = useState(false);
  const [item, setItem] = useState('');
  const [toFac, setToFac] = useState('');
  const [pbNote, setPbNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function submitPb() {
    if (!item.trim()) return;
    setBusy(true);
    const to = trip.factories.find((f) => f.id === toFac);
    await addPiggyback(trip.id, item, toFac || null, to?.name || null, pbNote);
    setBusy(false); location.reload();
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div>
          <span className="font-semibold text-gray-900">{trip.trip_date}</span>
          <span className="ml-2 text-xs text-gray-500">{trip.creator_name || '—'} 出车{trip.mine && ' · 我的'}</span>
          {trip.note && <span className="ml-2 text-xs text-gray-400">{trip.note}</span>}
        </div>
        {trip.mine && trip.status === 'planned' && (
          <button onClick={async () => { if (confirm('取消这个行程?')) { await cancelTrip(trip.id); location.reload(); } }}
            className="text-[11px] text-gray-400 hover:text-red-500">取消</button>
        )}
      </div>

      {/* 工厂 + 导航 */}
      <div className="space-y-1.5">
        {trip.factories.map((f, i) => (
          <div key={f.id} className="flex items-center gap-2 text-sm">
            <span className="shrink-0 w-5 h-5 rounded-full bg-indigo-100 text-indigo-700 text-xs flex items-center justify-center">{i + 1}</span>
            <span className="font-medium text-gray-800">{f.name}</span>
            <span className="text-xs text-gray-400 truncate">{f.address || f.city || '(无地址,去工厂管理补)'}</span>
            {f.address && (
              <span className="shrink-0 flex gap-1.5">
                <a href={amapLink(f.address)} target="_blank" rel="noreferrer" className="text-[11px] text-emerald-600 hover:underline">高德</a>
                <a href={baiduLink(f.address)} target="_blank" rel="noreferrer" className="text-[11px] text-blue-600 hover:underline">百度</a>
              </span>
            )}
          </div>
        ))}
      </div>

      {/* 捎带 */}
      {trip.piggybacks.length > 0 && (
        <div className="mt-3 rounded-lg bg-amber-50 border border-amber-100 p-2 space-y-1">
          <div className="text-xs font-medium text-amber-800">📦 捎带请求</div>
          {trip.piggybacks.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-2 text-xs text-gray-700">
              <span>{p.item}{p.to_factory_name ? ` → ${p.to_factory_name}` : ''}{p.note ? `(${p.note})` : ''} <span className="text-gray-400">· {p.requester_name}</span></span>
              <span className="flex items-center gap-1.5">
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${p.status === 'done' ? 'bg-green-100 text-green-700' : p.status === 'accepted' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-500'}`}>{({ requested: '待接', accepted: '已接', done: '已带到', cancelled: '取消' } as any)[p.status] || p.status}</span>
                {p.status !== 'done' && <button onClick={async () => { await updatePiggyback(p.id, p.status === 'requested' ? 'accepted' : 'done'); location.reload(); }} className="text-[10px] text-indigo-600 hover:underline">{p.status === 'requested' ? '我接' : '标已带'}</button>}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="mt-2">
        {!showPb ? (
          <button onClick={() => setShowPb(true)} className="text-xs text-indigo-600 hover:underline">+ 请他帮带东西</button>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5 rounded-lg bg-gray-50 p-2">
            <input value={item} onChange={(e) => setItem(e.target.value)} placeholder="带什么(如:面料样/辅料)" className="flex-1 min-w-[120px] rounded border border-gray-300 px-2 py-1 text-xs" />
            <select value={toFac} onChange={(e) => setToFac(e.target.value)} className="rounded border border-gray-300 px-1.5 py-1 text-xs">
              <option value="">带到哪家</option>
              {trip.factories.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
            <input value={pbNote} onChange={(e) => setPbNote(e.target.value)} placeholder="备注" className="w-24 rounded border border-gray-300 px-2 py-1 text-xs" />
            <button onClick={submitPb} disabled={busy || !item.trim()} className="rounded bg-indigo-600 px-2.5 py-1 text-xs text-white disabled:opacity-50">发</button>
            <button onClick={() => setShowPb(false)} className="text-xs text-gray-400">收起</button>
          </div>
        )}
      </div>
    </div>
  );
}
