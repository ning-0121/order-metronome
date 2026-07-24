'use client';
import { useEffect, useState } from 'react';
import {
  getPackagingConsolidation, setPackagingConsolidation, addGatherRecord, deleteGatherRecord,
} from '@/app/actions/packaging-consolidation';

const num = (n: any) => (Number(n) || 0).toLocaleString('zh-CN');

export function PackagingConsolidationSection({ orderId }: { orderId: string }) {
  const [header, setHeader] = useState<any>(null);
  const [records, setRecords] = useState<any[]>([]);
  const [gathered, setGathered] = useState(0);
  const [orderQty, setOrderQty] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // 头:指定厂 + 目标
  const [factory, setFactory] = useState('');
  const [target, setTarget] = useState('');
  // 加到货
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ from_factory: '', item_desc: '', qty: '', unit: '件', arrived_date: '' });

  const reload = async () => {
    const r = await getPackagingConsolidation(orderId);
    if ((r as any).error) { setError((r as any).error); return; }
    setHeader((r as any).header || null);
    setRecords((r as any).records || []);
    setGathered((r as any).gathered || 0);
    setOrderQty((r as any).orderQty ?? null);
    setFactory((r as any).header?.packing_factory || '');
    setTarget((r as any).header?.target_qty != null ? String((r as any).header.target_qty) : '');
  };
  useEffect(() => { reload().then(() => setLoading(false)); }, [orderId]);

  async function saveHeader() {
    setSaving(true); setError('');
    const r = await setPackagingConsolidation(orderId, {
      packing_factory: factory || undefined,
      target_qty: target ? parseFloat(target) : null,
    });
    if (r.error) setError(r.error); else await reload();
    setSaving(false);
  }

  async function handleAdd() {
    setSaving(true); setError('');
    const r = await addGatherRecord(orderId, {
      from_factory: form.from_factory, item_desc: form.item_desc || undefined,
      qty: parseFloat(form.qty) || 0, unit: form.unit || '件', arrived_date: form.arrived_date || undefined,
    });
    if (r.error) setError(r.error);
    else { setShowAdd(false); setForm({ from_factory: '', item_desc: '', qty: '', unit: '件', arrived_date: '' }); await reload(); }
    setSaving(false);
  }

  const goal = target ? parseFloat(target) : (orderQty ?? 0);
  const pct = goal > 0 ? Math.min(100, Math.round((gathered / goal) * 100)) : 0;
  const done = goal > 0 && gathered >= goal;
  const inp = 'rounded-lg border border-gray-300 px-3 py-2 text-sm';

  if (loading) return <div className="mt-8 pt-6 border-t border-gray-200 text-center py-6 text-gray-400 text-sm">加载中…</div>;

  return (
    <div className="mt-8 pt-6 border-t border-gray-200">
      <h3 className="text-sm font-semibold text-gray-800 mb-1">📦 包装归集(各厂成品汇集到包装厂)</h3>
      <p className="text-[11px] text-gray-400 mb-3">指定一个包装归集厂,各车缝厂/外发厂的成品陆续到货时逐批登记;系统算「已归集 vs 订单总量」,齐了再开包装装箱。</p>

      {/* 指定包装厂 + 目标 */}
      <div className="bg-gray-50 rounded-xl p-4 mb-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="text-xs text-gray-500 mb-1 block">包装归集厂</label>
          <input placeholder="哪家做最终包装" value={factory} onChange={e => setFactory(e.target.value)} className={inp} />
        </div>
        <div>
          <label className="text-xs text-gray-500 mb-1 block">目标总量{orderQty != null ? `(订单 ${num(orderQty)})` : ''}</label>
          <input placeholder={orderQty != null ? String(orderQty) : '总量'} type="number" value={target} onChange={e => setTarget(e.target.value)} className={`${inp} w-32`} />
        </div>
        <button onClick={saveHeader} disabled={saving} className="px-4 py-2 rounded-lg bg-gray-700 text-white text-sm font-medium disabled:opacity-50">保存</button>
      </div>

      {/* 进度 */}
      <div className="mb-4">
        <div className="flex items-center justify-between text-xs mb-1">
          <span className="text-gray-500">已归集 <b className="text-gray-800">{num(gathered)}</b> / 目标 <b className="text-gray-800">{goal > 0 ? num(goal) : '—'}</b>{goal > 0 ? ` · ${pct}%` : ''}</span>
          {done ? <span className="text-green-600 font-medium">✓ 已齐,可开包装</span>
            : goal > 0 ? <span className="text-amber-600 font-medium">还差 {num(goal - gathered)}</span> : null}
        </div>
        <div className="h-2.5 rounded-full bg-gray-100 overflow-hidden">
          <div className={`h-full rounded-full transition-all ${done ? 'bg-green-500' : 'bg-amber-500'}`} style={{ width: `${pct}%` }} />
        </div>
      </div>

      {/* 逐批到货 */}
      <div className="flex justify-between items-center mb-2">
        <span className="text-sm text-gray-500">{records.length} 批到货</span>
        {!showAdd && <button onClick={() => setShowAdd(true)} className="text-sm px-3 py-1.5 rounded-lg bg-teal-600 text-white font-medium hover:bg-teal-700">+ 登记到货</button>}
      </div>

      {showAdd && (
        <div className="bg-teal-50 rounded-xl p-4 mb-4 space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <input placeholder="来源厂(车缝厂)*" value={form.from_factory} onChange={e => setForm(f => ({ ...f, from_factory: e.target.value }))} className={inp} />
            <input placeholder="款色(如 黑色 M)" value={form.item_desc} onChange={e => setForm(f => ({ ...f, item_desc: e.target.value }))} className={inp} />
            <input placeholder="到货数量*" type="number" value={form.qty} onChange={e => setForm(f => ({ ...f, qty: e.target.value }))} className={inp} />
            <input placeholder="单位" value={form.unit} onChange={e => setForm(f => ({ ...f, unit: e.target.value }))} className={inp} />
            <div>
              <label className="text-xs text-gray-500 mb-1 block">到货日</label>
              <input type="date" value={form.arrived_date} onChange={e => setForm(f => ({ ...f, arrived_date: e.target.value }))} className={`w-full ${inp}`} />
            </div>
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex gap-2">
            <button onClick={handleAdd} disabled={saving || !form.from_factory.trim() || !form.qty} className="px-4 py-2 rounded-lg bg-teal-600 text-white text-sm font-medium disabled:opacity-50">保存</button>
            <button onClick={() => { setShowAdd(false); setError(''); }} className="px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-500">取消</button>
          </div>
        </div>
      )}

      {records.length > 0 && (
        <div className="space-y-2">
          {records.map(r => (
            <div key={r.id} className="flex items-center justify-between gap-2 border border-gray-200 rounded-lg px-4 py-2.5 text-sm">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-gray-900">{r.from_factory}</span>
                {r.item_desc && <span className="text-gray-500">· {r.item_desc}</span>}
                <span className="font-semibold text-gray-800">{num(r.qty)}{r.unit || '件'}</span>
                {r.arrived_date && <span className="text-xs text-gray-400">{r.arrived_date}</span>}
              </div>
              <button onClick={() => deleteGatherRecord(r.id, orderId).then(reload)} className="text-xs text-red-500 hover:underline shrink-0">删除</button>
            </div>
          ))}
        </div>
      )}
      {error && !showAdd && <p className="text-xs text-red-600 mt-2">{error}</p>}
    </div>
  );
}
