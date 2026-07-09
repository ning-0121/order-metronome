'use client';

// PI(形式发票)· 2026-07-09 用户:从生产单带款/色/面料/数量,FOB=客户PO成交价,交期=出厂日 → 生成草稿,
// 业务改价/折扣/交期/买方 → 保存 → 下载 Excel(贴样板)。卖方+银行固定,只读展示。
import { useEffect, useState } from 'react';
import { getPI, savePI, exportPI, type PIData, type PILine } from '@/app/actions/order-pi';

const n2 = (n: number) => (Math.round(n * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 });

export function PITab({ orderId }: { orderId: string }) {
  const [pi, setPi] = useState<(PIData & { seller: any; has_saved: boolean; order_no: string | null }) | null>(null);
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
  function addLine() { setPi(p => p ? { ...p, lines: [...p.lines, { style_no: '', color: '', fabric: '', qty: 0, fob: 0 }] } : p); }
  function delLine(i: number) { setPi(p => p ? { ...p, lines: p.lines.filter((_, j) => j !== i) } : p); }

  async function save() {
    if (!pi) return;
    setSaving(true); setMsg('');
    const { seller, has_saved, order_no, ...data } = pi as any;
    const r = await savePI(orderId, data as PIData);
    setSaving(false);
    setMsg((r as any).error ? '❌ ' + (r as any).error : '✅ 已保存 PI');
  }

  async function download() {
    if (!pi) return;
    setDl(true); setMsg('');
    // 先存再导(导出读库,保证下载的是最新编辑)
    const { seller, has_saved, order_no, ...data } = pi as any;
    const s = await savePI(orderId, data as PIData);
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

  const total = pi.lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.fob) || 0), 0);
  const disc = total * (Number(pi.discount_pct) || 0) / 100;
  const net = total - disc;
  const inp = 'rounded border border-gray-300 px-2 py-1 text-sm';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-gray-800">🧾 PI（形式发票 Proforma Invoice）</h3>
          <p className="text-xs text-gray-500 mt-0.5">从生产单带款/色/面料/数量,FOB=客户PO成交价,交期=出厂日。可改价/折扣/交期 → 保存 → 下载。{pi.has_saved ? <span className="text-emerald-600"> · 已存过</span> : <span className="text-amber-600"> · 草稿(未保存)</span>}</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={save} disabled={saving} className="text-sm px-3 py-2 rounded-lg border border-indigo-300 text-indigo-700 bg-white hover:bg-indigo-50 font-medium disabled:opacity-50">{saving ? '保存中…' : '💾 保存'}</button>
          <button onClick={download} disabled={dl} className="text-sm px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 font-medium disabled:opacity-50">{dl ? '导出中…' : '⬇ 下载 PI Excel'}</button>
        </div>
      </div>
      {msg && <div className={`rounded-lg px-3 py-2 text-sm ${msg.startsWith('✅') ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>{msg}</div>}

      {/* 表头:买方 + 合同号 + 交期 + 折扣 */}
      <div className="rounded-xl border border-gray-200 bg-white p-4 grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="text-xs text-gray-500">Buyer 买方<input value={pi.buyer_name} onChange={e => setH('buyer_name', e.target.value)} className={`${inp} w-full mt-0.5`} /></label>
        <label className="text-xs text-gray-500">PURCHASE CONTRACT# 合同号<input value={pi.contract_no} onChange={e => setH('contract_no', e.target.value)} className={`${inp} w-full mt-0.5`} /></label>
        <label className="text-xs text-gray-500">Buyer Address 买方地址<input value={pi.buyer_address} onChange={e => setH('buyer_address', e.target.value)} className={`${inp} w-full mt-0.5`} /></label>
        <label className="text-xs text-gray-500">Buyer TEL 买方电话<input value={pi.buyer_tel} onChange={e => setH('buyer_tel', e.target.value)} className={`${inp} w-full mt-0.5`} /></label>
        <label className="text-xs text-gray-500">READY TO SHIP DATE 交期<input value={pi.ready_to_ship} onChange={e => setH('ready_to_ship', e.target.value)} placeholder="2026/7/25" className={`${inp} w-full mt-0.5`} /></label>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs text-gray-500">Discount 折扣 %<input type="number" step="any" value={pi.discount_pct} onChange={e => setH('discount_pct', e.target.value === '' ? 0 : Number(e.target.value))} className={`${inp} w-full mt-0.5`} /></label>
          <label className="text-xs text-gray-500">Currency 币种<input value={pi.currency} onChange={e => setH('currency', e.target.value)} className={`${inp} w-full mt-0.5`} /></label>
        </div>
      </div>

      {/* 明细表 */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead><tr className="bg-gray-50 text-left text-gray-500 text-xs">
            {['STYLE # 款号', 'COLOR 颜色', 'FABRIC 面料', 'Quantity 数量', `FOB 单价`, `AMOUNT 金额`, ''].map(h => <th key={h} className="px-2 py-2 font-medium whitespace-nowrap">{h}</th>)}
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {pi.lines.map((l, i) => (
              <tr key={i}>
                <td className="px-2 py-1"><input value={l.style_no} onChange={e => setLine(i, 'style_no', e.target.value)} className={`${inp} w-28`} /></td>
                <td className="px-2 py-1"><input value={l.color} onChange={e => setLine(i, 'color', e.target.value)} className={`${inp} w-24`} /></td>
                <td className="px-2 py-1"><input value={l.fabric} onChange={e => setLine(i, 'fabric', e.target.value)} className={`${inp} w-44`} /></td>
                <td className="px-2 py-1"><input type="number" value={l.qty} onChange={e => setLine(i, 'qty', e.target.value === '' ? 0 : Number(e.target.value))} className={`${inp} w-20 text-right`} /></td>
                <td className="px-2 py-1"><input type="number" step="any" value={l.fob} onChange={e => setLine(i, 'fob', e.target.value === '' ? 0 : Number(e.target.value))} className={`${inp} w-20 text-right`} /></td>
                <td className="px-2 py-1 text-right font-mono text-indigo-700">{n2((Number(l.qty) || 0) * (Number(l.fob) || 0))}</td>
                <td className="px-2 py-1 text-center"><button onClick={() => delLine(i)} className="text-gray-300 hover:text-rose-500 text-xs">✕</button></td>
              </tr>
            ))}
            {pi.lines.length === 0 && <tr><td colSpan={7} className="px-2 py-6 text-center text-gray-400 text-sm">无明细(生产单里逐款明细为空)。点下方「加一行」手工录。</td></tr>}
          </tbody>
        </table>
      </div>
      <button onClick={addLine} className="text-sm px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">＋ 加一行</button>

      {/* 合计 */}
      <div className="rounded-xl border border-gray-200 bg-white p-4 max-w-sm ml-auto text-sm space-y-1">
        <div className="flex justify-between"><span className="text-gray-500">TOTAL</span><span className="font-mono">{pi.currency} {n2(total)}</span></div>
        <div className="flex justify-between"><span className="text-gray-500">Less {pi.discount_pct || 0}% Discount</span><span className="font-mono">{pi.currency} {n2(disc)}</span></div>
        <div className="flex justify-between font-semibold text-gray-900 border-t border-gray-100 pt-1"><span>Net Amount</span><span className="font-mono">{pi.currency} {n2(net)}</span></div>
      </div>

      {/* 卖方(固定,只读) */}
      <details className="rounded-xl border border-gray-200 bg-gray-50/50 p-3 text-xs text-gray-500">
        <summary className="cursor-pointer font-medium text-gray-600">Seller 卖方 + 银行信息（固定,导出自动带上）</summary>
        <p className="mt-2 whitespace-pre-wrap">{pi.seller.name}｜{pi.seller.address}｜TEL {pi.seller.tel}｜FAX {pi.seller.fax}{'\n\n'}{pi.seller.bank}</p>
      </details>
    </div>
  );
}
