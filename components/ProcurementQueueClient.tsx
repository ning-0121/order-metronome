'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  transitionProcurementLine,
  chaseProcurementLine,
  recordGoodsReceipt,
  type QueueLine,
} from '@/app/actions/procurement';

const LAMP: Record<string, string> = {
  red: 'bg-red-500', yellow: 'bg-yellow-400', green: 'bg-emerald-500',
};
const CAT: Record<string, string> = {
  fabric: '面料', trim: '辅料', packing: '包装', print: '印花', other: '其他',
};
const STATUS_LABEL: Record<string, string> = {
  pending_order: '待下单', ordered: '已下单', confirmed: '已确认',
  in_production: '生产中', shipped: '已发货', arrived: '已到厂',
};

function fmt(d: string | null) { return d ? d.slice(0, 10) : '—'; }

function LampDot({ lamp }: { lamp: string | null }) {
  if (!lamp) return <span className="inline-block w-2.5 h-2.5 rounded-full bg-gray-200" title="无截止/不监控" />;
  return <span className={`inline-block w-2.5 h-2.5 rounded-full ${LAMP[lamp]}`} title={lamp} />;
}

function RowShell({ line, children }: { line: QueueLine; children: React.ReactNode }) {
  return (
    <div className="border-b border-gray-100 py-2 px-3 hover:bg-gray-50">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <LampDot lamp={line.lamp} />
          <span className="font-medium text-gray-900 truncate">{line.material_name}</span>
          <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">{CAT[line.category || 'other'] || line.category}</span>
          <Link href={`/orders/${line.order_id}`} className="text-xs text-indigo-600 hover:underline shrink-0">
            {line.order_no}·{line.customer_name}
          </Link>
        </div>
        <div className="flex items-center gap-2 shrink-0">{children}</div>
      </div>
    </div>
  );
}

export function ProcurementQueueClient({
  pendingOrder, chase, receive,
}: { pendingOrder: QueueLine[]; chase: QueueLine[]; receive: QueueLine[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [openForm, setOpenForm] = useState<string | null>(null); // `${rowId}:${kind}`
  const [err, setErr] = useState('');

  async function run(key: string, fn: () => Promise<{ error?: string }>) {
    setBusy(key); setErr('');
    const r = await fn();
    setBusy(null);
    if (r?.error) { setErr(r.error); return false; }
    setOpenForm(null); router.refresh(); return true;
  }

  const btn = 'text-xs px-2 py-1 rounded font-medium disabled:opacity-50';

  return (
    <div className="space-y-6">
      {err && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{err}</div>}

      {/* ── 待下单 ── */}
      <section className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="bg-indigo-50 px-4 py-2.5 border-b border-indigo-100 font-bold text-indigo-900 text-sm">
          📝 待下单（{pendingOrder.length}）
        </div>
        {pendingOrder.length === 0 ? <Empty /> : pendingOrder.map(l => (
          <div key={l.id}>
            <RowShell line={l}>
              <span className="text-xs text-gray-400">需到 {fmt(l.required_by)}</span>
              <button className={`${btn} bg-indigo-600 text-white hover:bg-indigo-700`}
                onClick={() => setOpenForm(openForm === `${l.id}:order` ? null : `${l.id}:order`)}>下单</button>
              <button className={`${btn} border border-gray-200 text-gray-500`} disabled={busy === `${l.id}:cancel`}
                onClick={async () => { const reason = prompt('取消理由（必填）：'); if (reason) run(`${l.id}:cancel`, () => transitionProcurementLine(l.id, 'cancelled', { note: reason })); }}>取消</button>
            </RowShell>
            {openForm === `${l.id}:order` && (
              <OrderForm line={l} busy={busy === `${l.id}:order`}
                onSubmit={(p) => run(`${l.id}:order`, () => transitionProcurementLine(l.id, 'ordered', p))} />
            )}
          </div>
        ))}
      </section>

      {/* ── 待催货 ── */}
      <section className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="bg-amber-50 px-4 py-2.5 border-b border-amber-100 font-bold text-amber-900 text-sm">
          🔔 待催货 / 在途（{chase.length}）
        </div>
        {chase.length === 0 ? <Empty /> : chase.map(l => (
          <RowShell key={l.id} line={l}>
            <span className="text-xs text-gray-400">
              {STATUS_LABEL[l.line_status]} · 预计 {fmt(l.expected_arrival || l.promised_date)}
              {(l.chase_count ?? 0) > 0 && <span className="text-amber-600 ml-1">催{l.chase_count}次</span>}
            </span>
            <button className={`${btn} bg-amber-500 text-white hover:bg-amber-600`} disabled={busy === `${l.id}:chase`}
              onClick={async () => { const note = prompt('催货备注（可选）：') ?? undefined; run(`${l.id}:chase`, () => chaseProcurementLine(l.id, note)); }}>催货</button>
            {l.line_status === 'ordered' && (
              <button className={`${btn} border border-gray-200 text-gray-600`} disabled={busy === `${l.id}:conf`}
                onClick={() => run(`${l.id}:conf`, () => transitionProcurementLine(l.id, 'confirmed'))}>确认</button>
            )}
            {['ordered', 'confirmed', 'in_production'].includes(l.line_status) && (
              <button className={`${btn} border border-gray-200 text-gray-600`} disabled={busy === `${l.id}:ship`}
                onClick={() => run(`${l.id}:ship`, () => transitionProcurementLine(l.id, 'shipped'))}>发货</button>
            )}
            {l.line_status === 'shipped' && (
              <button className={`${btn} bg-emerald-600 text-white hover:bg-emerald-700`} disabled={busy === `${l.id}:arr`}
                onClick={() => run(`${l.id}:arr`, () => transitionProcurementLine(l.id, 'arrived'))}>到厂</button>
            )}
          </RowShell>
        ))}
      </section>

      {/* ── 待验收 ── */}
      <section className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="bg-emerald-50 px-4 py-2.5 border-b border-emerald-100 font-bold text-emerald-900 text-sm">
          ✅ 待验收（{receive.length}）
        </div>
        {receive.length === 0 ? <Empty /> : receive.map(l => (
          <div key={l.id}>
            <RowShell line={l}>
              <span className="text-xs text-gray-400">订购 {l.ordered_qty ?? '—'} {l.ordered_unit}</span>
              <button className={`${btn} bg-emerald-600 text-white hover:bg-emerald-700`}
                onClick={() => setOpenForm(openForm === `${l.id}:recv` ? null : `${l.id}:recv`)}>验收</button>
            </RowShell>
            {openForm === `${l.id}:recv` && (
              <ReceiveForm line={l} busy={!!busy && busy.startsWith(`${l.id}:recv`)}
                onSubmit={(p) => run(`${l.id}:recv:${p.result}`, () => recordGoodsReceipt(l.id, p))} />
            )}
          </div>
        ))}
      </section>
    </div>
  );
}

function Empty() { return <div className="px-4 py-6 text-center text-sm text-gray-400">暂无</div>; }

function OrderForm({ line, busy, onSubmit }: {
  line: QueueLine; busy: boolean;
  onSubmit: (p: { po_no?: string; unit_price?: number; supplier_name?: string; promised_date?: string }) => void;
}) {
  const [po, setPo] = useState('');
  const [price, setPrice] = useState('');
  const [supplier, setSupplier] = useState(line.supplier_name || '');
  const [promised, setPromised] = useState('');
  return (
    <div className="bg-indigo-50/50 px-3 py-3 grid grid-cols-2 md:grid-cols-4 gap-2 border-b border-gray-100">
      <input className="rounded border border-gray-300 px-2 py-1 text-xs" placeholder="采购单号 PO" value={po} onChange={e => setPo(e.target.value)} />
      <input className="rounded border border-gray-300 px-2 py-1 text-xs" placeholder="单价" type="number" step="0.01" value={price} onChange={e => setPrice(e.target.value)} />
      <input className="rounded border border-gray-300 px-2 py-1 text-xs" placeholder="供应商" value={supplier} onChange={e => setSupplier(e.target.value)} />
      <input className="rounded border border-gray-300 px-2 py-1 text-xs" type="date" title="承诺交期" value={promised} onChange={e => setPromised(e.target.value)} />
      <button disabled={busy}
        className="col-span-2 md:col-span-4 text-xs px-3 py-1.5 rounded bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50"
        onClick={() => onSubmit({
          po_no: po || undefined,
          unit_price: price ? parseFloat(price) : undefined,
          supplier_name: supplier || undefined,
          promised_date: promised || undefined,
        })}>
        {busy ? '提交中…' : '确认下单'}
      </button>
    </div>
  );
}

function ReceiveForm({ line, busy, onSubmit }: {
  line: QueueLine; busy: boolean;
  onSubmit: (p: { received_qty: number; result: 'pass' | 'concession' | 'reject'; defect_notes?: string }) => void;
}) {
  const [qty, setQty] = useState(line.ordered_qty?.toString() || '');
  const [defect, setDefect] = useState('');
  const submit = (result: 'pass' | 'concession' | 'reject') => {
    const q = parseFloat(qty);
    if (!(q >= 0)) return;
    onSubmit({ received_qty: q, result, defect_notes: defect || undefined });
  };
  return (
    <div className="bg-emerald-50/50 px-3 py-3 flex flex-wrap items-center gap-2 border-b border-gray-100">
      <input className="rounded border border-gray-300 px-2 py-1 text-xs w-28" placeholder={`实收(${line.ordered_unit || ''})`} type="number" step="0.01" value={qty} onChange={e => setQty(e.target.value)} />
      <input className="rounded border border-gray-300 px-2 py-1 text-xs flex-1 min-w-[160px]" placeholder="缺陷说明（让步/拒收必填写清楚）" value={defect} onChange={e => setDefect(e.target.value)} />
      <button disabled={busy} className="text-xs px-2 py-1 rounded bg-emerald-600 text-white font-medium hover:bg-emerald-700 disabled:opacity-50" onClick={() => submit('pass')}>通过</button>
      <button disabled={busy} className="text-xs px-2 py-1 rounded bg-amber-500 text-white font-medium hover:bg-amber-600 disabled:opacity-50" onClick={() => submit('concession')} title="需采购经理/管理员">让步</button>
      <button disabled={busy} className="text-xs px-2 py-1 rounded bg-red-500 text-white font-medium hover:bg-red-600 disabled:opacity-50" onClick={() => submit('reject')}>拒收</button>
    </div>
  );
}
