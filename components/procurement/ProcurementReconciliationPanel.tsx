'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  getOrCreateReconciliation, saveReconciliationLine, saveReconciliationHeader,
  confirmReconciliation, listPoReceiptBatches, createProcurementReturn, confirmProcurementReturn,
} from '@/app/actions/procurement-reconciliation';
import { listPaymentRequests, submitPaymentRequest } from '@/app/actions/procurement-payment';

const n2 = (v: any) => (v == null ? '' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 }));
const RET_TYPE: Record<string, string> = { return: '退货', replace: '换货', rework: '返修' };
const RET_STATUS: Record<string, string> = { draft: '草稿', returned: '已退', replaced: '已换', reworked: '已返修', closed: '已关', cancelled: '已取消', submitted: '已提交' };

export function ProcurementReconciliationPanel({ poId, canProcure = false }: { poId: string; canProcure?: boolean }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<any>(null);
  const [msg, setMsg] = useState('');
  const [showReturn, setShowReturn] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setMsg('');
    const r = await getOrCreateReconciliation(poId);
    setLoading(false);
    if ((r as any).error) { setMsg('❌ ' + (r as any).error); return; }
    setData((r as any).data);
  }, [poId]);

  useEffect(() => { if (open && !data) load(); }, [open, data, load]);

  if (!open) {
    return (
      <div className="mt-6">
        <button onClick={() => setOpen(true)}
          className="text-sm px-3 py-1.5 rounded-lg border border-teal-300 text-teal-700 hover:bg-teal-50 font-medium">
          📒 采购对账 / 退货返修
        </button>
      </div>
    );
  }

  const recon = data?.reconciliation;
  const lines = data?.lines || [];
  const returns = data?.returns || [];
  const locked = data?.locked;
  const editable = canProcure && !locked;

  async function saveLine(lineId: string, patch: any) {
    const r = await saveReconciliationLine(lineId, patch);
    if ((r as any).error) { setMsg('❌ ' + (r as any).error); return; }
    await load();
  }
  async function saveHeader(patch: any) {
    const r = await saveReconciliationHeader(recon.id, patch);
    if ((r as any).error) { setMsg('❌ ' + (r as any).error); return; }
    await load();
  }
  async function doConfirm(confirm: boolean) {
    if (confirm && !window.confirm(`确认对账?锁定净应付 ¥${n2(recon.net_payable)}。确认后不能改明细(可撤回)。`)) return;
    const r = await confirmReconciliation(recon.id, confirm);
    if ((r as any).error) { setMsg('❌ ' + (r as any).error); return; }
    setMsg(confirm ? '✅ 对账已确认(净应付已锁定;付款申请走 P2 提交财务)' : '✅ 已撤回确认');
    await load();
  }

  return (
    <div className="mt-6 rounded-xl border border-teal-200 bg-teal-50/40 p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-teal-800">📒 采购对账（供应商 × 本 PO）</h3>
          {recon && <StatusBadge status={recon.status} />}
        </div>
        <button onClick={() => setOpen(false)} className="text-xs text-gray-400 hover:text-gray-600">收起</button>
      </div>
      <div className="mb-2 rounded-md bg-amber-50 border border-amber-200 px-2.5 py-1.5 text-xs text-amber-800">
        ℹ️ 此对账只含<b>辅料 / 加工</b>;<b>面料应付</b>走「采购中心 · 📒 供应商对账台账」——避免同批面料两处重复付款。
      </div>
      {msg && <div className={`text-xs mb-2 ${msg.startsWith('✅') ? 'text-emerald-700' : 'text-rose-600'}`}>{msg}</div>}
      {loading && <p className="text-xs text-gray-400">加载中…</p>}

      {recon && (
        <>
          {/* 明细 */}
          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 text-left bg-gray-50">
                  {['物料', '码', '订购', '收货(系统)', '单价', '供应商数量', '供应商金额', '退货', '本行折扣', '本行净额'].map(h =>
                    <th key={h} className="py-1.5 px-2 font-medium whitespace-nowrap">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {lines.map((l: any) => {
                  const diff = l.supplier_qty != null && l.received_qty != null && Number(l.supplier_qty) !== Number(l.received_qty);
                  return (
                    <tr key={l.id} className="border-t border-gray-100">
                      <td className="py-1 px-2 text-gray-700 whitespace-nowrap">{l.material_name || '—'}</td>
                      <td className="py-1 px-2 text-gray-400">{l.size || '—'}</td>
                      <td className="py-1 px-2 text-gray-500">{n2(l.ordered_qty)}</td>
                      <td className={`py-1 px-2 ${diff ? 'text-rose-600 font-semibold' : 'text-gray-700'}`}>{n2(l.received_qty)}</td>
                      <td className="py-1 px-2 text-gray-500">{n2(l.unit_price)}</td>
                      <td className="py-1 px-2"><NumCell value={l.supplier_qty} disabled={!editable} onSave={(v) => saveLine(l.id, { supplier_qty: v })} /></td>
                      <td className="py-1 px-2"><NumCell value={l.supplier_amount} disabled={!editable} onSave={(v) => saveLine(l.id, { supplier_amount: v })} /></td>
                      <td className="py-1 px-2 text-amber-700">{Number(l.return_qty) > 0 ? n2(l.return_qty) : '—'}</td>
                      <td className="py-1 px-2"><NumCell value={l.line_discount} disabled={!editable} onSave={(v) => saveLine(l.id, { line_discount: v })} /></td>
                      <td className="py-1 px-2 font-medium text-teal-800">{n2(l.net_amount)}</td>
                    </tr>
                  );
                })}
                {lines.length === 0 && <tr><td colSpan={10} className="py-3 text-center text-gray-400">该采购单暂无采购行</td></tr>}
              </tbody>
            </table>
          </div>

          {/* 汇总 + 整单 */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3 text-xs">
            <Stat label="系统金额(收货×价)" value={`¥${n2(recon.system_amount)}`} />
            <Stat label="退货冲减" value={`−¥${n2(recon.return_amount)}`} amber />
            <label className="block">
              <span className="text-gray-500">整单折扣/返点</span>
              <NumCell value={recon.discount_amount} disabled={!editable} onSave={(v) => saveHeader({ discount_amount: v })} block />
            </label>
            <div className="rounded-lg border border-teal-300 bg-teal-100/60 px-2 py-1.5">
              <span className="text-teal-700">净应付</span>
              <div className="font-bold text-teal-900 text-sm">¥{n2(recon.net_payable)}</div>
            </div>
            <label className="block">
              <span className="text-gray-500">供应商对账单金额</span>
              <NumCell value={recon.supplier_statement_amount} disabled={!editable} onSave={(v) => saveHeader({ supplier_statement_amount: v })} block />
              {recon.supplier_statement_amount != null && Number(recon.supplier_statement_amount) !== Number(recon.net_payable) && (
                <span className="text-[10px] text-rose-600">与净应付差 ¥{n2(Number(recon.supplier_statement_amount) - Number(recon.net_payable))}</span>
              )}
            </label>
            {recon.status === 'paid' || Number(recon.paid_amount) > 0 ? <Stat label="已付" value={`¥${n2(recon.paid_amount)}`} /> : null}
          </div>

          {/* 操作 */}
          <div className="flex items-center gap-2 mt-3 flex-wrap">
            {editable && <button onClick={() => setShowReturn(!showReturn)} className="text-xs px-3 py-1.5 rounded-lg border border-amber-300 text-amber-700 hover:bg-amber-50">↩ 退货 / 返修</button>}
            {canProcure && recon.status === 'draft' && <button onClick={() => doConfirm(true)} className="text-xs px-3 py-1.5 rounded-lg bg-teal-600 text-white font-medium hover:bg-teal-700">✔ 确认对账</button>}
            {canProcure && recon.status === 'confirmed' && <button onClick={() => doConfirm(false)} className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50">↺ 撤回确认</button>}
            {recon.status === 'confirmed' && <span className="text-[11px] text-teal-600">已确认。付款申请(分批·每周·自定义金额)走 P2 提交财务。</span>}
          </div>

          {showReturn && editable && <ReturnForm poId={poId} onDone={() => { setShowReturn(false); load(); }} />}

          {/* 付款申请(分批·每周·自定义金额)——对账确认后可提 */}
          {['confirmed', 'submitted', 'paid'].includes(recon.status) && (
            <PaymentRequests reconId={recon.id} canProcure={canProcure} onChanged={load} />
          )}

          {/* 退货/返修列表 */}
          {returns.length > 0 && (
            <div className="mt-3">
              <div className="text-xs font-semibold text-gray-500 mb-1">退货/返修单（{returns.length}）</div>
              <ul className="space-y-1">
                {returns.map((r: any) => (
                  <li key={r.id} className="flex items-center gap-2 text-xs bg-white rounded border border-gray-100 px-2 py-1">
                    <span className="font-mono text-gray-600">{r.return_no}</span>
                    <span className="px-1.5 rounded bg-amber-100 text-amber-700">{RET_TYPE[r.type] || r.type}</span>
                    <span className="text-gray-500">{RET_STATUS[r.status] || r.status}</span>
                    <span className="text-gray-400">数量 {n2(r.total_qty)}{r.type === 'return' ? ` · 冲减 ¥${n2(r.total_amount)}` : ''}</span>
                    {r.status === 'draft' && editable && (
                      <button onClick={async () => { const x = await confirmProcurementReturn(r.id); if ((x as any).error) setMsg('❌ ' + (x as any).error); else load(); }}
                        className="ml-auto text-teal-600 hover:underline">确认</button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const m: Record<string, [string, string]> = {
    draft: ['采购对账中', 'bg-gray-100 text-gray-600'], confirmed: ['采购已确认', 'bg-teal-100 text-teal-700'],
    submitted: ['已推财务', 'bg-indigo-100 text-indigo-700'], paid: ['已付', 'bg-emerald-100 text-emerald-700'],
    cancelled: ['已取消', 'bg-rose-100 text-rose-700'],
  };
  const [label, cls] = m[status] || [status, 'bg-gray-100 text-gray-600'];
  return <span className={`text-[11px] px-1.5 py-0.5 rounded-full ${cls}`}>{label}</span>;
}
function Stat({ label, value, amber }: { label: string; value: string; amber?: boolean }) {
  return <div className="rounded-lg border border-gray-200 bg-white px-2 py-1.5"><span className="text-gray-500">{label}</span><div className={`font-semibold ${amber ? 'text-amber-700' : 'text-gray-800'}`}>{value}</div></div>;
}
function NumCell({ value, disabled, onSave, block }: { value: any; disabled?: boolean; onSave: (v: string) => void; block?: boolean }) {
  const [v, setV] = useState(value == null ? '' : String(value));
  useEffect(() => { setV(value == null ? '' : String(value)); }, [value]);
  return (
    <input type="number" step="any" value={v} disabled={disabled}
      onChange={e => setV(e.target.value)}
      onBlur={() => { if (String(value ?? '') !== v) onSave(v); }}
      className={`${block ? 'w-full mt-1' : 'w-20'} rounded border border-gray-300 px-1.5 py-1 text-right disabled:bg-gray-50 disabled:text-gray-500`} />
  );
}

function ReturnForm({ poId, onDone }: { poId: string; onDone: () => void }) {
  const [batches, setBatches] = useState<any[]>([]);
  const [type, setType] = useState<'return' | 'replace' | 'rework'>('return');
  const [reason, setReason] = useState('');
  const [rows, setRows] = useState<Array<{ line_item_id: string; goods_receipt_id: string; qty: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { (async () => { const r = await listPoReceiptBatches(poId); if ((r as any).data) setBatches((r as any).data); })(); }, [poId]);

  const disposition = type === 'return' ? 'refund' : type === 'replace' ? 'replace' : 'rework';

  async function submit() {
    const lines = rows.filter(x => x.goods_receipt_id && Number(x.qty) > 0).map(x => {
      const b = batches.find(bb => bb.id === x.goods_receipt_id);
      return { line_item_id: b?.line_item_id, goods_receipt_id: x.goods_receipt_id, qty: Number(x.qty), disposition };
    });
    if (lines.length === 0) { setErr('请选收货批次并填退货数量'); return; }
    setBusy(true); setErr('');
    const r = await createProcurementReturn(poId, { type, reason, lines } as any);
    setBusy(false);
    if ((r as any).error) { setErr((r as any).error); return; }
    onDone();
  }

  return (
    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50/50 p-3 space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-semibold text-amber-800">↩ 新建退货/返修</span>
        <select value={type} onChange={e => setType(e.target.value as any)} className="rounded border border-gray-300 px-2 py-1">
          <option value="return">退货(冲减应付)</option>
          <option value="replace">换货</option>
          <option value="rework">返修</option>
        </select>
        <input value={reason} onChange={e => setReason(e.target.value)} placeholder="原因(如质量不良)" className="flex-1 rounded border border-gray-300 px-2 py-1" />
      </div>
      <div className="space-y-1">
        {rows.map((row, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <select value={row.goods_receipt_id} onChange={e => setRows(rs => rs.map((x, j) => j === i ? { ...x, goods_receipt_id: e.target.value } : x))}
              className="flex-1 rounded border border-gray-300 px-2 py-1">
              <option value="">选收货批次…</option>
              {batches.map(b => <option key={b.id} value={b.id}>{(b.received_at || '').slice(0, 10)} · 收 {n2(b.received_qty)} · {b.inspection_result || 'pass'}</option>)}
            </select>
            <input type="number" step="any" value={row.qty} onChange={e => setRows(rs => rs.map((x, j) => j === i ? { ...x, qty: e.target.value } : x))}
              placeholder="退货量" className="w-24 rounded border border-gray-300 px-2 py-1 text-right" />
            <button onClick={() => setRows(rs => rs.filter((_, j) => j !== i))} className="text-gray-300 hover:text-rose-500">×</button>
          </div>
        ))}
        <button onClick={() => setRows(rs => [...rs, { line_item_id: '', goods_receipt_id: '', qty: '' }])} className="text-xs text-amber-700 hover:underline">+ 加一行</button>
      </div>
      {err && <div className="text-xs text-rose-600">❌ {err}</div>}
      <div className="flex gap-2">
        <button onClick={submit} disabled={busy} className="text-xs px-3 py-1.5 rounded-lg bg-amber-600 text-white font-medium hover:bg-amber-700 disabled:opacity-50">{busy ? '提交中…' : '建退货单(草稿)'}</button>
        <button onClick={onDone} className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-500">取消</button>
      </div>
    </div>
  );
}

const PR_STATUS: Record<string, [string, string]> = {
  draft: ['草稿', 'bg-gray-100 text-gray-600'], submitted: ['已提交财务', 'bg-indigo-100 text-indigo-700'],
  approved: ['财务已批', 'bg-teal-100 text-teal-700'], paid: ['已付', 'bg-emerald-100 text-emerald-700'],
  rejected: ['已驳回', 'bg-rose-100 text-rose-700'], cancelled: ['已取消', 'bg-gray-100 text-gray-500'],
};

function PaymentRequests({ reconId, canProcure, onChanged }: { reconId: string; canProcure: boolean; onChanged: () => void }) {
  const [data, setData] = useState<any>(null);
  const [amount, setAmount] = useState('');
  const [week, setWeek] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => { const r = await listPaymentRequests(reconId); if ((r as any).data) setData((r as any).data); }, [reconId]);
  useEffect(() => { load(); }, [load]);

  async function submit() {
    const amt = Number(amount);
    if (!(amt > 0)) { setErr('请输入付款金额'); return; }
    setBusy(true); setErr('');
    const r = await submitPaymentRequest(reconId, amt, { week_label: week || undefined });
    setBusy(false);
    if ((r as any).error) { setErr((r as any).error); return; }
    setAmount(''); setWeek('');
    await load(); onChanged();
  }

  if (!data) return null;
  return (
    <div className="mt-3 rounded-lg border border-indigo-200 bg-indigo-50/40 p-3 space-y-2">
      <div className="text-xs font-semibold text-indigo-800">💸 付款申请（分批·每周·自定义金额）</div>
      <div className="grid grid-cols-4 gap-2 text-xs">
        <div><span className="text-gray-500">净应付</span><div className="font-semibold text-gray-800">¥{n2(data.net_payable)}</div></div>
        <div><span className="text-gray-500">已申请</span><div className="font-semibold text-indigo-700">¥{n2(data.requested)}</div></div>
        <div><span className="text-gray-500">剩余可申请</span><div className="font-bold text-indigo-900">¥{n2(data.remaining)}</div></div>
        <div><span className="text-gray-500">已付</span><div className="font-semibold text-emerald-700">¥{n2(data.paid_amount)}</div></div>
      </div>
      {data.requests.length > 0 && (
        <ul className="space-y-1">
          {data.requests.map((r: any) => {
            const [label, cls] = PR_STATUS[r.status] || [r.status, 'bg-gray-100 text-gray-600'];
            return (
              <li key={r.id} className="flex items-center gap-2 text-xs bg-white rounded border border-gray-100 px-2 py-1">
                <span className="font-mono text-gray-600">{r.request_no}</span>
                <span className="font-semibold text-gray-800">¥{n2(r.amount)}</span>
                {r.week_label && <span className="text-gray-400">{r.week_label}</span>}
                <span className={`ml-auto text-[11px] px-1.5 py-0.5 rounded-full ${cls}`}>{label}</span>
              </li>
            );
          })}
        </ul>
      )}
      {canProcure && data.remaining > 0.01 && (
        <div className="flex items-center gap-2 flex-wrap">
          <input type="number" step="any" value={amount} onChange={e => setAmount(e.target.value)} placeholder={`本笔金额(≤${n2(data.remaining)})`}
            className="w-40 rounded border border-gray-300 px-2 py-1 text-xs text-right" />
          <input value={week} onChange={e => setWeek(e.target.value)} placeholder="周次/备注(可选)" className="w-40 rounded border border-gray-300 px-2 py-1 text-xs" />
          <button onClick={submit} disabled={busy} className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50">{busy ? '提交中…' : '提交付款申请'}</button>
          {err && <span className="text-[11px] text-rose-600">{err}</span>}
        </div>
      )}
      {data.remaining <= 0.01 && <div className="text-[11px] text-gray-400">净应付已全部提交付款申请。</div>}
    </div>
  );
}
