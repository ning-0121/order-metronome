'use client';
import { useEffect, useState, useCallback } from 'react';
import { getShippingDraft, saveShippingLines } from '@/app/actions/packing';
import { generatePackingList } from '@/app/actions/generate-packing-list';

/**
 * 出运节点「录实际出货 → 生成单据」。
 * P1:逐款×色录实发数量 + 装箱参数(每箱数/箱数/箱规/毛净重)→ 存 packing_list_lines → 生成 Packing List。
 * (CI / 报关 为 P2 / P3,占位按钮先留出。)
 */
export function ShippingDocsSection({ orderId }: { orderId: string }) {
  const [loading, setLoading] = useState(true);
  const [order, setOrder] = useState<any>(null);
  const [plId, setPlId] = useState<string>('');
  const [plNumber, setPlNumber] = useState<string>('');
  const [rows, setRows] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const [gen, setGen] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    const r = await getShippingDraft(orderId);
    if ((r as any).error) { setErr((r as any).error); setLoading(false); return; }
    const d = (r as any).data;
    setOrder(d.order); setPlId(d.packingListId); setPlNumber(d.plNumber); setRows(d.rows || []);
    setLoading(false);
  }, [orderId]);
  useEffect(() => { if (open) load(); }, [open, load]);

  const setField = (i: number, k: string, v: string) =>
    setRows(rs => rs.map((row, idx) => idx === i ? { ...row, [k]: v } : row));

  const num = (v: any) => (v === '' || v == null ? 0 : Number(v) || 0);
  // 客户端合计预览
  const tot = rows.reduce((a, l) => {
    const cartons = num(l.carton_count);
    a.cartons += cartons;
    a.qty += num(l.actual_qty) || cartons * num(l.qty_per_carton);
    a.gross += cartons * num(l.gross_weight_per_carton);
    const dl = num(l.dim_l), dw = num(l.dim_w), dh = num(l.dim_h);
    if (dl && dw && dh) a.vol += (dl * dw * dh) * cartons / 1_000_000;
    return a;
  }, { cartons: 0, qty: 0, gross: 0, vol: 0 });

  async function save() {
    setSaving(true); setErr(''); setMsg('');
    const r = await saveShippingLines(orderId, plId, rows);
    setSaving(false);
    if ((r as any).error) { setErr((r as any).error); return; }
    setMsg('✅ 出货数据已保存'); await load();
  }

  async function downloadPL() {
    setGen(true); setErr(''); setMsg('');
    // 先存,保证生成用最新数据
    const s = await saveShippingLines(orderId, plId, rows);
    if ((s as any).error) { setErr((s as any).error); setGen(false); return; }
    const res = await generatePackingList(orderId);
    setGen(false);
    if ((res as any).error || !(res as any).base64) { setErr((res as any).error || '生成失败'); return; }
    const bytes = atob((res as any).base64);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    const blob = new Blob([arr], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = (res as any).fileName; a.click();
    URL.revokeObjectURL(url);
    setMsg('✅ Packing List 已生成下载');
  }

  const inp = 'w-full rounded border border-gray-300 px-1.5 py-1 text-xs text-center';

  return (
    <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 bg-gradient-to-r from-sky-50 to-white hover:bg-sky-50">
        <span className="font-semibold text-gray-800">📦 出货单据(录实发装箱 → 生成 Packing List / CI / 报关)</span>
        <span className="text-xs text-gray-400">{open ? '收起 ▲' : '展开 ▼'}</span>
      </button>

      {open && (
        <div className="p-4 space-y-3">
          {loading ? <div className="text-center py-6 text-gray-400 text-sm">加载中…</div> : (<>
            {err && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{err}</div>}
            {msg && <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-3 py-2">{msg}</div>}
            <div className="flex items-center gap-2 flex-wrap text-xs text-gray-500">
              <span>装箱单号 <b className="text-gray-700">{plNumber}</b></span>
              <span>· 客户 {order?.customer_name || '—'}</span>
              <span>· PO# {order?.po_number || '—'}</span>
              <span className="ml-auto">按 款×色 录实发数量 + 装箱参数;成分/尺码/PO# 生成时自动带出</span>
            </div>

            {rows.length === 0 ? (
              <div className="text-center py-6 text-gray-400 text-sm">该订单暂无款/色明细(需先在富录入表填款色数量)</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="bg-gray-50 text-gray-500">
                      {['款号', '颜色', '订单量', '实发数量', '每箱数', '箱数', '每箱净重kg', '每箱毛重kg', '长cm', '宽cm', '高cm'].map(h => (
                        <th key={h} className="border border-gray-100 px-1.5 py-1 font-medium whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((l, i) => (
                      <tr key={i} className="hover:bg-gray-50">
                        <td className="border border-gray-100 px-1.5 py-1 font-mono whitespace-nowrap">{l.style_no || '—'}</td>
                        <td className="border border-gray-100 px-1.5 py-1 whitespace-nowrap">{l.color || '—'}</td>
                        <td className="border border-gray-100 px-1.5 py-1 text-center text-gray-400">{l.order_qty || '—'}</td>
                        <td className="border border-gray-100 px-1 py-0.5"><input className={inp} type="number" value={l.actual_qty ?? ''} onChange={e => setField(i, 'actual_qty', e.target.value)} /></td>
                        <td className="border border-gray-100 px-1 py-0.5"><input className={inp} type="number" value={l.qty_per_carton ?? ''} onChange={e => setField(i, 'qty_per_carton', e.target.value)} /></td>
                        <td className="border border-gray-100 px-1 py-0.5"><input className={inp} type="number" value={l.carton_count ?? ''} onChange={e => setField(i, 'carton_count', e.target.value)} /></td>
                        <td className="border border-gray-100 px-1 py-0.5"><input className={inp} type="number" step="0.01" value={l.net_weight_per_carton ?? ''} onChange={e => setField(i, 'net_weight_per_carton', e.target.value)} /></td>
                        <td className="border border-gray-100 px-1 py-0.5"><input className={inp} type="number" step="0.01" value={l.gross_weight_per_carton ?? ''} onChange={e => setField(i, 'gross_weight_per_carton', e.target.value)} /></td>
                        <td className="border border-gray-100 px-1 py-0.5"><input className={inp} type="number" value={l.dim_l ?? ''} onChange={e => setField(i, 'dim_l', e.target.value)} /></td>
                        <td className="border border-gray-100 px-1 py-0.5"><input className={inp} type="number" value={l.dim_w ?? ''} onChange={e => setField(i, 'dim_w', e.target.value)} /></td>
                        <td className="border border-gray-100 px-1 py-0.5"><input className={inp} type="number" value={l.dim_h ?? ''} onChange={e => setField(i, 'dim_h', e.target.value)} /></td>
                      </tr>
                    ))}
                    <tr className="bg-sky-50 font-semibold text-gray-700">
                      <td className="border border-gray-100 px-1.5 py-1" colSpan={3}>合计</td>
                      <td className="border border-gray-100 px-1.5 py-1 text-center">{tot.qty || '—'}</td>
                      <td className="border border-gray-100 px-1.5 py-1"></td>
                      <td className="border border-gray-100 px-1.5 py-1 text-center">{tot.cartons || '—'}</td>
                      <td className="border border-gray-100 px-1.5 py-1"></td>
                      <td className="border border-gray-100 px-1.5 py-1 text-center" title="总毛重">{tot.gross ? Math.round(tot.gross * 10) / 10 : '—'}</td>
                      <td className="border border-gray-100 px-1.5 py-1 text-center" colSpan={3} title="总体积M³">{tot.vol ? `${Math.round(tot.vol * 1000) / 1000} M³` : '—'}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}

            <div className="flex items-center gap-2 flex-wrap pt-1">
              <button onClick={save} disabled={saving || rows.length === 0}
                className="text-sm px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 font-medium hover:bg-gray-50 disabled:opacity-50">
                {saving ? '保存中…' : '💾 保存出货数据'}</button>
              <button onClick={downloadPL} disabled={gen || rows.length === 0}
                className="text-sm px-3 py-1.5 rounded-lg bg-sky-600 text-white font-medium hover:bg-sky-700 disabled:opacity-50">
                {gen ? '生成中…' : '📦 生成 Packing List'}</button>
              <button disabled title="P2 即将上线" className="text-sm px-3 py-1.5 rounded-lg bg-gray-100 text-gray-400 font-medium cursor-not-allowed">💰 生成 CI(P2)</button>
              <button disabled title="P3 即将上线" className="text-sm px-3 py-1.5 rounded-lg bg-gray-100 text-gray-400 font-medium cursor-not-allowed">🛃 生成报关资料(P3)</button>
            </div>
          </>)}
        </div>
      )}
    </div>
  );
}
