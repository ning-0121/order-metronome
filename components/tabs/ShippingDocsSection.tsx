'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { getShippingDraft, saveShippingLines, saveShippingDocMeta } from '@/app/actions/packing';
import { generatePackingList } from '@/app/actions/generate-packing-list';
import { generateCommercialInvoice, generateCustomsDocs, previewShippingDocs } from '@/app/actions/shipping-docs';
import { getShipmentBatches } from '@/app/actions/shipment-batches';

function downloadBase64(base64: string, fileName: string) {
  const bytes = atob(base64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  const blob = new Blob([arr], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = fileName; a.click();
  URL.revokeObjectURL(url);
}

/**
 * 出运节点「录实际出货 → 生成单据」。
 * P1 Packing List + P2 CI(单价取 PO 价 / 可选币种 / 业务填页脚) + 预览。报关(P3)占位。
 */
export function ShippingDocsSection({ orderId }: { orderId: string }) {
  const [loading, setLoading] = useState(true);
  const [order, setOrder] = useState<any>(null);
  const [plId, setPlId] = useState('');
  const [plNumber, setPlNumber] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  const [batches, setBatches] = useState<any[]>([]);        // 分批出货批次(空=整单)
  const [batchId, setBatchId] = useState<string | null>(null);
  const [batchesLoaded, setBatchesLoaded] = useState(false);
  const [meta, setMeta] = useState<any>({ currency: 'USD', bank: {} });
  const [saving, setSaving] = useState(false);
  const [gen, setGen] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(true);   // 默认展开:这是出货主操作区
  const [metaOpen, setMetaOpen] = useState(false);
  const [czOpen, setCzOpen] = useState(false);
  const [preview, setPreview] = useState<any>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    const r = await getShippingDraft(orderId, batchId);
    if ((r as any).error) { setErr((r as any).error); setLoading(false); return; }
    const d = (r as any).data;
    setOrder(d.order); setPlId(d.packingListId); setPlNumber(d.plNumber); setRows(d.rows || []);
    const dm = d.docMeta || {};
    setMeta({ currency: 'USD', ...dm, bank: { ...(dm.bank || {}) } });
    setLoading(false);
  }, [orderId, batchId]);
  // 展开时先探分批批次:有批次 → 默认选第一批(分批模式);无 → 整单(batchId=null)
  useEffect(() => {
    if (!open || batchesLoaded) return;
    getShipmentBatches(orderId).then(r => {
      const bs = ((r as any).data || []).filter((b: any) => b.status !== 'cancelled');
      setBatches(bs); setBatchesLoaded(true);
      if (bs.length > 0) setBatchId(bs[0].id);
    });
  }, [open, batchesLoaded, orderId]);
  useEffect(() => { if (open && batchesLoaded) load(); }, [open, batchesLoaded, load]);

  const setField = (i: number, k: string, v: string) => setRows(rs => rs.map((row, idx) => idx === i ? { ...row, [k]: v } : row));
  const metaDirty = useRef(false);
  const setM = (k: string, v: any) => { metaDirty.current = true; setMeta((m: any) => ({ ...m, [k]: v })); };
  const setBank = (k: string, v: any) => { metaDirty.current = true; setMeta((m: any) => ({ ...m, bank: { ...(m.bank || {}), [k]: v } })); };

  // 单据信息(CI/报关表头)编辑后防抖自动保存(离开页面前早已存好;手动「保存单据信息」按钮做保底)。
  // 只在用户真编辑过(metaDirty)且草稿单据已就绪(plId)时触发;仅存 doc_meta,不碰实发数量行。
  useEffect(() => {
    if (!metaDirty.current || !plId) return;
    const t = setTimeout(async () => {
      const r = await saveShippingDocMeta(orderId, plId, meta);
      if (!(r as any)?.error) { metaDirty.current = false; setMsg('✓ 单据信息已自动保存'); }
    }, 1500);
    return () => clearTimeout(t);
  }, [meta, plId, orderId]);
  const setCz = (k: string, v: any) => setMeta((m: any) => ({ ...m, customs: { ...(m.customs || {}), [k]: v } }));
  const setCzStyle = (style: string, k: string, v: any) => setMeta((m: any) => {
    const cz = m.customs || {}; const styles = { ...(cz.styles || {}) };
    styles[style] = { ...(styles[style] || {}), [k]: v };
    return { ...m, customs: { ...cz, styles } };
  });
  const uniqueStyles = [...new Set(rows.map(r => r.style_no).filter(Boolean))];

  const num = (v: any) => (v === '' || v == null ? 0 : Number(v) || 0);
  const tot = rows.reduce((a, l) => {
    const cartons = num(l.carton_count);
    a.cartons += cartons; a.qty += num(l.actual_qty) || cartons * num(l.qty_per_carton);
    a.gross += cartons * num(l.gross_weight_per_carton);
    const dl = num(l.dim_l), dw = num(l.dim_w), dh = num(l.dim_h);
    if (dl && dw && dh) a.vol += (dl * dw * dh) * cartons / 1_000_000;
    return a;
  }, { cartons: 0, qty: 0, gross: 0, vol: 0 });

  async function persist() {
    const s = await saveShippingLines(orderId, plId, rows);
    if ((s as any).error) return (s as any).error;
    const mm = await saveShippingDocMeta(orderId, plId, meta);
    if ((mm as any).error) return (mm as any).error;
    return null;
  }
  async function save() {
    setSaving(true); setErr(''); setMsg('');
    const e = await persist(); setSaving(false);
    if (e) { setErr(e); return; }
    setMsg('✅ 出货数据 + 单据信息已保存'); await load();
  }
  // 只存单据信息(CI/报关表头 doc_meta)——不碰实发数量行,故没录实发数量也能保存表头(修:原来只有
  // 「保存实发数量」按钮,且它 rows=0 时禁用 → 手工填的 CI/报关表头存不下)。
  async function saveMeta() {
    if (!plId) return;
    setSaving(true); setErr(''); setMsg('');
    const mm = await saveShippingDocMeta(orderId, plId, meta);
    setSaving(false);
    if ((mm as any).error) { setErr((mm as any).error); return; }
    setMsg('✅ 单据信息(CI/报关表头)已保存');
  }
  async function doGen(kind: 'pl' | 'ci' | 'customs') {
    setGen(kind); setErr(''); setMsg('');
    const e = await persist();
    if (e) { setErr(e); setGen(''); return; }
    const res = kind === 'pl' ? await generatePackingList(orderId, batchId)
      : kind === 'ci' ? await generateCommercialInvoice(orderId, batchId)
      : await generateCustomsDocs(orderId, batchId);
    setGen('');
    if ((res as any).error || !(res as any).base64) { setErr((res as any).error || '生成失败'); return; }
    downloadBase64((res as any).base64, (res as any).fileName);
    setMsg(`✅ ${kind === 'pl' ? 'Packing List' : kind === 'ci' ? 'CI' : '报关资料'} 已生成下载`);
  }
  async function doPreview() {
    setGen('preview'); setErr(''); setMsg('');
    const e = await persist();
    if (e) { setErr(e); setGen(''); return; }
    const res = await previewShippingDocs(orderId, batchId);
    setGen('');
    if ((res as any).error) { setErr((res as any).error); return; }
    setPreview((res as any).data);
  }

  const inp = 'w-full rounded border border-gray-300 px-1.5 py-1 text-xs text-center';
  const finp = 'rounded border border-gray-300 px-2 py-1 text-xs';
  const cur = meta.currency === 'CNY' ? 'RMB' : 'USD';

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

            {/* 分批出货:每批各自实发数量 + 各自一套单据 */}
            {batches.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                <span className="text-xs font-medium text-amber-800 mr-1">📦 分批出货 · 选批次:</span>
                {batches.map((b, i) => (
                  <button key={b.id} onClick={() => setBatchId(b.id)}
                    className={`text-xs px-2.5 py-1 rounded-full border font-medium ${batchId === b.id ? 'border-amber-500 bg-amber-500 text-white' : 'border-amber-300 bg-white text-amber-700 hover:bg-amber-100'}`}>
                    批次{b.batch_no || i + 1}{b.etd ? ` · ETD ${String(b.etd).slice(5)}` : ''}{b.status && b.status !== 'planned' ? ` · ${({ shipped: '已发', delivered: '已到' } as any)[b.status] || b.status}` : ''}
                  </button>
                ))}
                <span className="text-[11px] text-amber-600 ml-1">当前批单据只含该批分配到的款/色/数量</span>
              </div>
            )}

            <div className="flex items-center gap-2 flex-wrap text-xs text-gray-500">
              <span>装箱单号 <b className="text-gray-700">{plNumber}</b>{batches.length > 0 ? <span className="ml-1 text-amber-600">(批次{batches.find(b => b.id === batchId)?.batch_no || ''})</span> : null}</span>
              <span>· 客户 {order?.customer_name || '—'}</span>
              <span>· PO# {order?.po_number || '—'}</span>
              <label className="ml-auto flex items-center gap-1">币种
                <select value={meta.currency} onChange={e => setM('currency', e.target.value)} className="rounded border border-gray-300 px-2 py-0.5">
                  <option value="USD">美元 USD</option>
                  <option value="CNY">人民币 RMB</option>
                </select>
              </label>
            </div>

            {/* 出货装箱明细 */}
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
                      <td className="border border-gray-100 px-1.5 py-1 text-center" colSpan={3}>{tot.vol ? `${Math.round(tot.vol * 1000) / 1000} M³` : '—'}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}

            {/* CI 抬头/页脚(业务填) */}
            <div className="rounded-lg border border-gray-200">
              <button onClick={() => setMetaOpen(o => !o)} className="w-full flex items-center justify-between px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
                <span>🧾 CI 单据信息(业务填:发运/付款条件/银行 —— 生成 CI 用)</span><span className="text-xs text-gray-400">{metaOpen ? '收起 ▲' : '展开 ▼'}</span>
              </button>
              {metaOpen && (
                <div className="p-3 border-t border-gray-100 grid grid-cols-2 md:grid-cols-4 gap-2">
                  <label className="flex flex-col gap-0.5 text-[11px] text-gray-500">开票日期<input type="date" className={finp} value={meta.issue_date || ''} onChange={e => setM('issue_date', e.target.value)} /></label>
                  <label className="flex flex-col gap-0.5 text-[11px] text-gray-500">SHIP VIA<input className={finp} value={meta.ship_via || ''} onChange={e => setM('ship_via', e.target.value)} placeholder="SEA DDP SHANGHAI" /></label>
                  <label className="flex flex-col gap-0.5 text-[11px] text-gray-500">目的地 DESTINATION<input className={finp} value={meta.destination || ''} onChange={e => setM('destination', e.target.value)} placeholder="NY" /></label>
                  <label className="flex flex-col gap-0.5 text-[11px] text-gray-500">定金 DEPOSIT ({cur})<input type="number" className={finp} value={meta.deposit ?? ''} onChange={e => setM('deposit', e.target.value)} /></label>
                  <label className="flex flex-col gap-0.5 text-[11px] text-gray-500">HBL#<input className={finp} value={meta.hbl || ''} onChange={e => setM('hbl', e.target.value)} placeholder="To be updated" /></label>
                  <label className="flex flex-col gap-0.5 text-[11px] text-gray-500">柜号 CONTAINER#<input className={finp} value={meta.container_no || ''} onChange={e => setM('container_no', e.target.value)} /></label>
                  <label className="flex flex-col gap-0.5 text-[11px] text-gray-500">ETD<input type="date" className={finp} value={meta.etd || ''} onChange={e => setM('etd', e.target.value)} /></label>
                  <label className="flex flex-col gap-0.5 text-[11px] text-gray-500">ETA<input type="date" className={finp} value={meta.eta || ''} onChange={e => setM('eta', e.target.value)} /></label>
                  <label className="flex flex-col gap-0.5 text-[11px] text-gray-500 col-span-2">付款条件 PAYMENT TERMS<input className={finp} value={meta.payment_terms || ''} onChange={e => setM('payment_terms', e.target.value)} placeholder="10% DEPOSIT, BALANCE PAYMENT BEFORE DELIVERY" /></label>
                  <label className="flex flex-col gap-0.5 text-[11px] text-gray-500">运费 FREIGHT<input className={finp} value={meta.freight || ''} onChange={e => setM('freight', e.target.value)} placeholder="DELIVERED TO NY WH" /></label>
                  <label className="flex flex-col gap-0.5 text-[11px] text-gray-500">出厂日 EXIT FACTORY<input type="date" className={finp} value={meta.exit_factory_date || ''} onChange={e => setM('exit_factory_date', e.target.value)} /></label>
                  <div className="col-span-2 md:col-span-4 mt-1 text-[11px] font-semibold text-gray-600">银行信息 BANK INFORMATION</div>
                  <label className="flex flex-col gap-0.5 text-[11px] text-gray-500">收款银行 BANK<input className={finp} value={meta.bank?.beneficiary_bank || ''} onChange={e => setBank('beneficiary_bank', e.target.value)} /></label>
                  <label className="flex flex-col gap-0.5 text-[11px] text-gray-500">SWIFT BIC<input className={finp} value={meta.bank?.swift || ''} onChange={e => setBank('swift', e.target.value)} /></label>
                  <label className="flex flex-col gap-0.5 text-[11px] text-gray-500 col-span-2">银行地址 BANK ADD<input className={finp} value={meta.bank?.bank_address || ''} onChange={e => setBank('bank_address', e.target.value)} /></label>
                  <label className="flex flex-col gap-0.5 text-[11px] text-gray-500">收款人 BENEFICIARY<input className={finp} value={meta.bank?.beneficiary_name || ''} onChange={e => setBank('beneficiary_name', e.target.value)} /></label>
                  <label className="flex flex-col gap-0.5 text-[11px] text-gray-500">ROUTING NO.<input className={finp} value={meta.bank?.routing_no || ''} onChange={e => setBank('routing_no', e.target.value)} /></label>
                  <label className="flex flex-col gap-0.5 text-[11px] text-gray-500">ACCOUNT NO.<input className={finp} value={meta.bank?.account_no || ''} onChange={e => setBank('account_no', e.target.value)} /></label>
                  <label className="flex flex-col gap-0.5 text-[11px] text-gray-500">公司地址 COMPANY ADD<input className={finp} value={meta.bank?.company_address || ''} onChange={e => setBank('company_address', e.target.value)} /></label>
                </div>
              )}
            </div>

            {/* 报关信息(业务填,存 doc_meta.customs) */}
            <div className="rounded-lg border border-gray-200">
              <button onClick={() => setCzOpen(o => !o)} className="w-full flex items-center justify-between px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
                <span>🛃 报关信息(海关字段 + 每款 HS 编码/报关品名 —— 生成报关资料用)</span><span className="text-xs text-gray-400">{czOpen ? '收起 ▲' : '展开 ▼'}</span>
              </button>
              {czOpen && (
                <div className="p-3 border-t border-gray-100 space-y-3">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    {([['overseas_buyer', '境外收货人'], ['overseas_addr', '收货人地址'], ['contract_no', '合同协议号(默认PO)'], ['customs_port', '出境关别(宁波港)'], ['transport', '运输方式(江海运输)'], ['supervision', '监管方式(一般贸易)'], ['levy_type', '征免性质(一般征税)'], ['trade_terms', '成交方式(FOB)'], ['trade_country', '贸易国(美国)'], ['dest_country', '运抵国(美国)'], ['dest_port', '指运港'], ['exit_port', '离境口岸'], ['package_type', '包装种类'], ['source_place', '境内货源地(义乌)'], ['origin_country', '原产国(中国)']] as [string, string][]).map(([k, label]) => (
                      <label key={k} className="flex flex-col gap-0.5 text-[11px] text-gray-500">{label}
                        <input className={finp} value={(meta.customs?.[k]) ?? ''} onChange={e => setCz(k, e.target.value)} placeholder={label.match(/\((.+)\)/)?.[1] || ''} />
                      </label>
                    ))}
                  </div>
                  {uniqueStyles.length > 0 && (
                    <div className="overflow-x-auto">
                      <div className="text-[11px] font-semibold text-gray-600 mb-1">每款报关信息</div>
                      <table className="w-full text-xs border-collapse">
                        <thead><tr className="bg-gray-50 text-gray-500">{['款号', 'HS 编码', '报关品名', '规格型号', '单位'].map(h => <th key={h} className="border border-gray-100 px-1.5 py-1 font-medium">{h}</th>)}</tr></thead>
                        <tbody>
                          {uniqueStyles.map(st => {
                            const cs = meta.customs?.styles?.[st] || {};
                            return (
                              <tr key={st}>
                                <td className="border border-gray-100 px-1.5 py-1 font-mono whitespace-nowrap">{st}</td>
                                <td className="border border-gray-100 px-1 py-0.5"><input className={inp + ' text-left'} value={cs.hs_code ?? ''} onChange={e => setCzStyle(st, 'hs_code', e.target.value)} placeholder="6104230000" /></td>
                                <td className="border border-gray-100 px-1 py-0.5"><input className={inp + ' text-left'} value={cs.customs_name ?? ''} onChange={e => setCzStyle(st, 'customs_name', e.target.value)} placeholder="女式针织便服套装" /></td>
                                <td className="border border-gray-100 px-1 py-0.5"><input className={inp + ' text-left'} value={cs.customs_spec ?? ''} onChange={e => setCzStyle(st, 'customs_spec', e.target.value)} placeholder="1.女式针织便服套装 2.针织..." /></td>
                                <td className="border border-gray-100 px-1 py-0.5"><input className={inp} value={cs.unit ?? ''} onChange={e => setCzStyle(st, 'unit', e.target.value)} placeholder="套" /></td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 操作 */}
            <div className="flex items-center gap-2 flex-wrap pt-1">
              <button onClick={saveMeta} disabled={saving || !plId} className="text-sm px-3 py-1.5 rounded-lg border border-teal-300 text-teal-700 font-medium hover:bg-teal-50 disabled:opacity-50" title="保存上方 CI/报关 表头(开票/银行/海关字段);没录实发数量也能存">{saving ? '保存中…' : '💾 保存单据信息'}</button>
              <button onClick={save} disabled={saving || rows.length === 0} className="text-sm px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 font-medium hover:bg-gray-50 disabled:opacity-50">{saving ? '保存中…' : '① 💾 保存实发数量'}</button>
              <button onClick={doPreview} disabled={!!gen || rows.length === 0} className="text-sm px-3 py-1.5 rounded-lg border border-indigo-300 text-indigo-700 font-medium hover:bg-indigo-50 disabled:opacity-50">{gen === 'preview' ? '生成中…' : '👁 预览'}</button>
              <span className="text-xs text-gray-400">按顺序生成 →</span>
              <button onClick={() => doGen('pl')} disabled={!!gen || rows.length === 0} className="text-sm px-3 py-1.5 rounded-lg bg-sky-600 text-white font-medium hover:bg-sky-700 disabled:opacity-50">{gen === 'pl' ? '生成中…' : '② 📦 Packing List'}</button>
              <button onClick={() => doGen('ci')} disabled={!!gen || rows.length === 0} className="text-sm px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-medium hover:bg-emerald-700 disabled:opacity-50">{gen === 'ci' ? '生成中…' : '③ 💰 CI'}</button>
              <button onClick={() => doGen('customs')} disabled={!!gen || rows.length === 0} className="text-sm px-3 py-1.5 rounded-lg bg-amber-600 text-white font-medium hover:bg-amber-700 disabled:opacity-50">{gen === 'customs' ? '生成中…' : '④ 🛃 报关资料'}</button>
            </div>

            {/* 预览 */}
            {preview && <DocPreview data={preview} onClose={() => setPreview(null)} />}
          </>)}
        </div>
      )}
    </div>
  );
}

function DocPreview({ data, onClose }: { data: any; onClose: () => void }) {
  const cur = data.currency?.label || 'USD';
  const money = (v: any) => (v == null ? '—' : `${data.currency?.symbol || ''}${v}`);
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-auto p-4" onClick={onClose}>
      <div className="bg-white rounded-xl max-w-5xl w-full my-6 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <span className="font-semibold text-gray-800">👁 单据预览(与导出 Excel 同源)</span>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-sm">关闭 ✕</button>
        </div>
        <div className="p-4 space-y-5 text-xs">
          <div className="text-center">
            <div className="font-bold text-sm">{data.seller?.name_en}</div>
            <div className="text-gray-500">{data.seller?.address_en}</div>
          </div>

          {/* Packing List */}
          <div>
            <div className="font-bold text-gray-800 mb-1">📦 PACKING LIST</div>
            <div className="overflow-x-auto"><table className="w-full border-collapse">
              <thead><tr className="bg-gray-50 text-gray-500">{['款号', '成分', '尺码', '颜色', '箱数', '每箱', '数量', 'L', 'W', 'H', '毛重kg', '体积M³'].map(h => <th key={h} className="border px-1 py-0.5">{h}</th>)}</tr></thead>
              <tbody>
                {data.plRows?.map((l: any, i: number) => (
                  <tr key={i}><td className="border px-1 py-0.5 font-mono">{l.style_no}</td><td className="border px-1 py-0.5">{l.composition}</td><td className="border px-1 py-0.5 whitespace-pre">{l.sizeText}</td><td className="border px-1 py-0.5">{l.color}</td><td className="border px-1 py-0.5 text-center">{l.cartons}</td><td className="border px-1 py-0.5 text-center">{l.per}</td><td className="border px-1 py-0.5 text-center">{l.qty}</td><td className="border px-1 py-0.5 text-center">{l.dl}</td><td className="border px-1 py-0.5 text-center">{l.dw}</td><td className="border px-1 py-0.5 text-center">{l.dh}</td><td className="border px-1 py-0.5 text-center">{l.grossTotal}</td><td className="border px-1 py-0.5 text-center">{l.vol}</td></tr>
                ))}
                <tr className="bg-sky-50 font-semibold"><td className="border px-1 py-0.5" colSpan={4}>TOTAL</td><td className="border px-1 py-0.5 text-center">{data.plTotals?.cartons}</td><td className="border"></td><td className="border px-1 py-0.5 text-center">{data.plTotals?.qty}</td><td className="border" colSpan={3}></td><td className="border px-1 py-0.5 text-center">{Math.round((data.plTotals?.gross || 0) * 10) / 10}</td><td className="border px-1 py-0.5 text-center">{Math.round((data.plTotals?.vol || 0) * 1000) / 1000}</td></tr>
              </tbody>
            </table></div>
          </div>

          {/* CI */}
          <div>
            <div className="font-bold text-gray-800 mb-1">💰 COMMERCIAL INVOICE {!data.canSeeFin && <span className="text-amber-600 font-normal">(你无价格权限,单价/金额不显示)</span>}</div>
            <div className="overflow-x-auto"><table className="w-full border-collapse">
              <thead><tr className="bg-gray-50 text-gray-500">{['款号', '尺码', '颜色分布', '描述', '成分', '箱数', '每箱', '数量', `单价${cur}`, `金额${cur}`].map(h => <th key={h} className="border px-1 py-0.5">{h}</th>)}</tr></thead>
              <tbody>
                {data.ciStyles?.map((s: any, i: number) => (
                  <tr key={i}><td className="border px-1 py-0.5 font-mono">{s.style_no}</td><td className="border px-1 py-0.5 whitespace-pre">{s.sizeRatio}</td><td className="border px-1 py-0.5 whitespace-pre">{s.colorBreakdown}</td><td className="border px-1 py-0.5">{s.description}</td><td className="border px-1 py-0.5">{s.composition}</td><td className="border px-1 py-0.5 text-center">{s.cartons}</td><td className="border px-1 py-0.5 text-center">{s.per}</td><td className="border px-1 py-0.5 text-center">{s.qty}</td><td className="border px-1 py-0.5 text-center">{money(s.unitPrice)}</td><td className="border px-1 py-0.5 text-center">{money(s.amount)}</td></tr>
                ))}
                <tr className="bg-emerald-50 font-semibold"><td className="border px-1 py-0.5" colSpan={5}>TOTAL</td><td className="border px-1 py-0.5 text-center">{data.ciTotals?.cartons}</td><td className="border"></td><td className="border px-1 py-0.5 text-center">{data.ciTotals?.qty}</td><td className="border"></td><td className="border px-1 py-0.5 text-center">{data.canSeeFin ? money(data.ciTotals?.amount) : '—'}</td></tr>
              </tbody>
            </table></div>
            {data.canSeeFin && (data.ciTotals?.missingPrice || 0) > 0 && (
              <div className="mt-2 text-xs px-2 py-1 rounded bg-red-50 border border-red-200 text-red-700 font-medium">
                ⚠ 有 {data.ciTotals.missingPrice} 款缺客户成交价 —— 发票 TOTAL 金额<b>不含</b>这些款,金额虚低。请先在 PI/订单补价再出 CI,否则报关/收汇金额不实。
              </div>
            )}
            <div className="mt-2 text-gray-600 space-y-0.5">
              {data.docMeta?.deposit ? <div>DEPOSIT: {money(Number(data.docMeta.deposit))} · BALANCE: {data.canSeeFin ? money(Math.round(((data.ciTotals?.amount || 0) - Number(data.docMeta.deposit)) * 100) / 100) : '—'}</div> : null}
              <div className="font-semibold mt-1">TERMS & BANK</div>
              <div>1. PAYMENT: {data.docMeta?.payment_terms || '—'}</div>
              <div>2. FREIGHT: {data.docMeta?.freight || '—'}</div>
              <div>3. EXIT FACTORY: {data.docMeta?.exit_factory_date || '—'}</div>
              <div>BANK: {data.docMeta?.bank?.beneficiary_bank || '—'} · SWIFT {data.docMeta?.bank?.swift || '—'} · A/C {data.docMeta?.bank?.account_no || '—'} · {data.docMeta?.bank?.beneficiary_name || '—'}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
