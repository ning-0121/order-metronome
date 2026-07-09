'use client';

// PI(形式发票)· 2026-07-09 用户:严格对齐绮陌标准 PI 模板(14 列 A–N + Jojo Fashion 抬头 + 运输表头 + DEPOSIT)。
// 从生产单按款归组生成草稿(款/色逐色带量/尺码/箱数/数量/PO价),业务补齐成分/克重/运输信息 → 保存 → 下载 Excel。
import { useEffect, useState } from 'react';
import { getPI, savePI, exportPI, type PIData, type PILine } from '@/app/actions/order-pi';

const n2 = (n: number) => (Math.round(n * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 });

type Bundle = PIData & { issuer: { company: string; address: string; contact: string; title: string }; has_saved: boolean; order_no: string | null };

// 明细列定义(对齐模板 A–N;multiline 的用 textarea)
const COLS: { key: keyof PILine; label: string; w: string; type?: 'num' | 'multi' }[] = [
  { key: 'po_no', label: 'PO NO.', w: 'w-24' },
  { key: 'style_no', label: 'STYLE NO.', w: 'w-28' },
  { key: 'style', label: 'STYLE', w: 'w-28' },
  { key: 'size', label: 'SIZE', w: 'w-28', type: 'multi' },
  { key: 'color', label: 'COLOR', w: 'w-44', type: 'multi' },
  { key: 'description', label: 'DESCRIPTION', w: 'w-40', type: 'multi' },
  { key: 'composition', label: 'COMPOSITION', w: 'w-36', type: 'multi' },
  { key: 'fabric_weight', label: 'FABRIC WEIGHT', w: 'w-24' },
  { key: 'total_carton', label: 'TOTAL CARTON', w: 'w-20', type: 'num' },
  { key: 'unit_per_carton', label: 'UNIT/CTN', w: 'w-20', type: 'num' },
  { key: 'qty', label: 'QTY(SETS/PCS)', w: 'w-20', type: 'num' },
  { key: 'unit_price', label: 'UNIT PRICE LDP', w: 'w-24', type: 'num' },
  { key: 'notes', label: 'NOTES', w: 'w-36', type: 'multi' },
];

export function PITab({ orderId }: { orderId: string }) {
  const [pi, setPi] = useState<Bundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dl, setDl] = useState(false);
  const [msg, setMsg] = useState('');

  async function load() {
    setLoading(true);
    const r = await getPI(orderId);
    if ((r as any).error) { setMsg((r as any).error); setLoading(false); return; }
    setPi((r as any).data); setLoading(false);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [orderId]);

  function setH<K extends keyof PIData>(k: K, v: any) { setPi(p => p ? { ...p, [k]: v } : p); setMsg(''); }
  function setLine(i: number, k: keyof PILine, v: any) { setPi(p => p ? { ...p, lines: p.lines.map((l, j) => j === i ? { ...l, [k]: v } : l) } : p); setMsg(''); }
  function addLine() { setPi(p => p ? { ...p, lines: [...p.lines, { po_no: p.lines[0]?.po_no || '', style_no: '', style: '', size: '', color: '', description: '', composition: '', fabric_weight: '', total_carton: 0, unit_per_carton: 0, qty: 0, unit_price: 0, notes: '' }] } : p); }
  function delLine(i: number) { setPi(p => p ? { ...p, lines: p.lines.filter((_, j) => j !== i) } : p); }

  function strip(p: Bundle): PIData {
    const { issuer, has_saved, order_no, ...data } = p as any;
    return data as PIData;
  }

  async function save() {
    if (!pi) return;
    setSaving(true); setMsg('');
    const r = await savePI(orderId, strip(pi));
    setSaving(false);
    setMsg((r as any).error ? '❌ ' + (r as any).error : '✅ 已保存 PI');
  }

  async function download() {
    if (!pi) return;
    setDl(true); setMsg('');
    const s = await savePI(orderId, strip(pi)); // 先存再导(导出读库)
    if ((s as any).error) { setMsg('❌ ' + (s as any).error); setDl(false); return; }
    const r = await exportPI(orderId);
    setDl(false);
    if ((r as any).error || !r.base64) { setMsg('❌ ' + ((r as any).error || '导出失败')); return; }
    const bin = atob(r.base64); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const blob = new Blob([arr], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = r.fileName || 'PI.xlsx'; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  }

  if (loading) return <div className="text-center py-8 text-gray-400 text-sm">加载 PI…</div>;
  if (!pi) return <div className="rounded-lg bg-rose-50 text-rose-700 px-4 py-3 text-sm">{msg || '无法加载 PI'}</div>;

  const sumCarton = pi.lines.reduce((s, l) => s + (Number(l.total_carton) || 0), 0);
  const sumQty = pi.lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
  const sumAmount = pi.lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unit_price) || 0), 0);
  const inp = 'rounded border border-gray-300 px-2 py-1 text-sm';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-gray-800">🧾 PI（形式发票 Proforma Invoice）</h3>
          <p className="text-xs text-gray-500 mt-0.5">按绮陌标准模板(14 列)。款/色/尺码/数量/箱数/PO价自动带出,业务补齐成分·克重·运输信息 → 保存 → 下载。
            {pi.has_saved ? <span className="text-emerald-600"> · 已存过</span> : <span className="text-amber-600"> · 草稿(未保存)</span>}</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={save} disabled={saving} className="text-sm px-3 py-2 rounded-lg border border-indigo-300 text-indigo-700 bg-white hover:bg-indigo-50 font-medium disabled:opacity-50">{saving ? '保存中…' : '💾 保存'}</button>
          <button onClick={download} disabled={dl} className="text-sm px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 font-medium disabled:opacity-50">{dl ? '导出中…' : '⬇ 下载 PI Excel'}</button>
        </div>
      </div>
      {msg && <div className={`rounded-lg px-3 py-2 text-sm ${msg.startsWith('✅') ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>{msg}</div>}

      {/* 开票方抬头(固定) */}
      <div className="rounded-lg border border-gray-200 bg-gray-50/60 px-4 py-2 text-center">
        <div className="font-bold text-gray-800">{pi.issuer.company}</div>
        <div className="text-xs text-gray-500">{pi.issuer.address}</div>
        <div className="text-xs text-gray-500">{pi.issuer.contact}</div>
        <div className="text-xs font-semibold text-gray-700 mt-1">{pi.issuer.title}</div>
      </div>

      {/* 买方 + 运输表头 */}
      <div className="rounded-xl border border-gray-200 bg-white p-4 grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3">
        <label className="text-xs text-gray-500">BUYER 买方<input value={pi.buyer_name} onChange={e => setH('buyer_name', e.target.value)} className={`${inp} w-full mt-0.5`} /></label>
        <label className="text-xs text-gray-500">INVOICE NO. 发票号<input value={pi.invoice_no} onChange={e => setH('invoice_no', e.target.value)} className={`${inp} w-full mt-0.5`} /></label>
        <label className="text-xs text-gray-500">BUYER ADDRESS 买方地址<input value={pi.buyer_address} onChange={e => setH('buyer_address', e.target.value)} className={`${inp} w-full mt-0.5`} /></label>
        <label className="text-xs text-gray-500">ISSUE DATE 开票日期<input value={pi.issue_date} onChange={e => setH('issue_date', e.target.value)} placeholder="2026-05-13" className={`${inp} w-full mt-0.5`} /></label>
        <label className="text-xs text-gray-500">TEL 买方电话<input value={pi.buyer_tel} onChange={e => setH('buyer_tel', e.target.value)} className={`${inp} w-full mt-0.5`} /></label>
        <label className="text-xs text-gray-500">SHIP VIA 运输方式<input value={pi.ship_via} onChange={e => setH('ship_via', e.target.value)} placeholder="SEA DDP SHANGHAI PORT" className={`${inp} w-full mt-0.5`} /></label>
        <label className="text-xs text-gray-500">DESTINATION 目的地<input value={pi.destination} onChange={e => setH('destination', e.target.value)} placeholder="NY" className={`${inp} w-full mt-0.5`} /></label>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs text-gray-500">ETD<input value={pi.etd} onChange={e => setH('etd', e.target.value)} className={`${inp} w-full mt-0.5`} /></label>
          <label className="text-xs text-gray-500">ETA<input value={pi.eta} onChange={e => setH('eta', e.target.value)} className={`${inp} w-full mt-0.5`} /></label>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs text-gray-500">HBL#<input value={pi.hbl} onChange={e => setH('hbl', e.target.value)} className={`${inp} w-full mt-0.5`} /></label>
          <label className="text-xs text-gray-500">CONTAINER#<input value={pi.container} onChange={e => setH('container', e.target.value)} className={`${inp} w-full mt-0.5`} /></label>
        </div>
        <label className="text-xs text-gray-500">Currency 币种<input value={pi.currency} onChange={e => setH('currency', e.target.value)} className={`${inp} w-full mt-0.5`} /></label>
      </div>

      {/* 明细表(14 列,横向滚动) */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
        <table className="text-sm">
          <thead><tr className="bg-gray-50 text-left text-gray-500 text-xs">
            {COLS.map(c => <th key={c.key} className="px-1.5 py-2 font-medium whitespace-nowrap">{c.label}</th>)}
            <th className="px-1.5 py-2 font-medium text-right whitespace-nowrap">AMOUNT LDP</th>
            <th className="px-1 py-2"></th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100 align-top">
            {pi.lines.map((l, i) => (
              <tr key={i}>
                {COLS.map(c => (
                  <td key={c.key} className="px-1 py-1">
                    {c.type === 'multi'
                      ? <textarea value={String(l[c.key] ?? '')} onChange={e => setLine(i, c.key, e.target.value)} rows={2} className={`${inp} ${c.w} resize-y`} />
                      : c.type === 'num'
                        ? <input type="number" step="any" value={l[c.key] as number} onChange={e => setLine(i, c.key, e.target.value === '' ? 0 : Number(e.target.value))} className={`${inp} ${c.w} text-right`} />
                        : <input value={String(l[c.key] ?? '')} onChange={e => setLine(i, c.key, e.target.value)} className={`${inp} ${c.w}`} />}
                  </td>
                ))}
                <td className="px-1.5 py-1 text-right font-mono text-indigo-700 whitespace-nowrap">{n2((Number(l.qty) || 0) * (Number(l.unit_price) || 0))}</td>
                <td className="px-1 py-1 text-center"><button onClick={() => delLine(i)} className="text-gray-300 hover:text-rose-500 text-xs">✕</button></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-gray-50 font-semibold text-gray-800 text-xs">
              <td className="px-1.5 py-2" colSpan={8}>TOTAL</td>
              <td className="px-1.5 py-2 text-right font-mono">{n2(sumCarton)}</td>
              <td></td>
              <td className="px-1.5 py-2 text-right font-mono">{n2(sumQty)}</td>
              <td></td>
              <td className="px-1.5 py-2 text-right font-mono">{pi.currency} {n2(sumAmount)}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <button onClick={addLine} className="text-sm px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">＋ 加一行</button>

      {/* DEPOSIT / 付款条款 */}
      <label className="block text-xs text-gray-500">DEPOSIT / 付款条款(定金、余款、条件等)
        <textarea value={pi.deposit} onChange={e => setH('deposit', e.target.value)} rows={2} className={`${inp} w-full mt-0.5`} placeholder="如:30% DEPOSIT, BALANCE BEFORE SHIPMENT" />
      </label>

      <p className="text-xs text-gray-400">提示:COLOR/SIZE/DESCRIPTION 支持多行(单元格内换行);AMOUNT = 数量 × 单价 自动算;合计箱数/数量/金额自动汇总。导出 Excel 与模板列序、抬头一致。</p>
    </div>
  );
}
