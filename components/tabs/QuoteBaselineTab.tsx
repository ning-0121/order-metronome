'use client';

import { useEffect, useState } from 'react';
import { getQuoteBaseline, saveQuoteBaseline, parseQuoteFile, type QuoteBaselineLine } from '@/app/actions/quote-baseline';

const CATS: Array<{ v: string; l: string }> = [
  { v: 'fabric', l: '面料' }, { v: 'trim', l: '辅料' }, { v: 'packing', l: '包装' },
  { v: 'print', l: '印花' }, { v: 'washing', l: '水洗' }, { v: 'other', l: '其他' },
];

type Row = QuoteBaselineLine & { _k: number };
const emptyRow = (k: number): Row => ({ _k: k, style_no: '', material_name: '', category: 'fabric', color: '', quote_consumption: null, quote_unit_price: null, quote_unit: 'kg', notes: '' });

/**
 * 报价基线录入(源头·单一真相):业务逐料填 单耗 + 单价 + 加工费 → 冻结成基线。
 * 供 BOM/核料超单耗超价对照、财务报价→预算。价列对非价角色屏蔽。
 */
export function QuoteBaselineTab({ orderId }: { orderId: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [cmt, setCmt] = useState<string>('');
  const [styleBudgets, setStyleBudgets] = useState<any[]>([]);   // 款预算(解析器填,手动表原样保留不冲掉)
  const [canEdit, setCanEdit] = useState(false);
  const [canPrice, setCanPrice] = useState(false);
  const [frozenAt, setFrozenAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  let kc = 0;

  async function load() {
    setLoading(true);
    const res = await getQuoteBaseline(orderId);
    if ((res as any).error) { setMsg({ ok: false, text: (res as any).error }); setLoading(false); return; }
    const d = res.data!;
    setRows((d.lines.length ? d.lines : []).map((l) => ({ ...l, _k: kc++ })));
    setCmt(d.cmt_quote != null ? String(d.cmt_quote) : '');
    setStyleBudgets((d as any).styleBudgets || []);
    setCanEdit(d.can_edit); setCanPrice(d.can_see_price); setFrozenAt(d.frozen_at);
    setLoading(false);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [orderId]);

  function patch(k: number, f: Partial<Row>) { setRows((rs) => rs.map((r) => r._k === k ? { ...r, ...f } : r)); setMsg(null); }
  function addRow() { setRows((rs) => [...rs, emptyRow(Date.now() + rs.length)]); }
  function delRow(k: number) { setRows((rs) => rs.filter((r) => r._k !== k)); }

  const [parsing, setParsing] = useState(false);
  async function onUpload(file: File) {
    setParsing(true); setMsg(null);
    try {
      const b64 = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader(); fr.onload = () => resolve(String(fr.result)); fr.onerror = reject; fr.readAsDataURL(file);
      });
      const res = await parseQuoteFile(b64);
      if ((res as any).error) { setMsg({ ok: false, text: (res as any).error }); return; }
      let k = Date.now();
      setRows((res.lines || []).map((l) => ({ ...l, _k: k++ })));
      setStyleBudgets((res as any).styleBudgets || []);
      setMsg({ ok: true, text: `✅ 已解析 ${(res.lines || []).length} 料 / ${((res as any).styleBudgets || []).length} 款 —— 请核对/修改后点「冻结报价基线」` });
    } finally { setParsing(false); }
  }

  async function save() {
    setSaving(true); setMsg(null);
    const res = await saveQuoteBaseline(orderId, {
      cmt_quote: cmt.trim() === '' ? null : Number(cmt),
      lines: rows.map(({ _k, ...l }) => l),
      styleBudgets,   // 原样带回,手动保存不冲掉解析器填的款预算
    });
    setSaving(false);
    if ((res as any).error) { setMsg({ ok: false, text: (res as any).error }); return; }
    setMsg({ ok: true, text: `✅ 报价基线已冻结(${(res as any).count} 料)` });
    load();
  }

  if (loading) return <div className="text-center py-8 text-gray-400">加载中…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-gray-800">报价基线 · 成本单一真相</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            逐料填「报价单耗 + 报价单价」,冻结后作为 BOM/核料超单耗超价对照 与 财务预算的基准。
            {frozenAt ? <span className="text-emerald-600"> · 已冻结 {String(frozenAt).slice(0, 10)}</span> : <span className="text-amber-600"> · 未冻结</span>}
          </p>
        </div>
        {canEdit && (
          <div className="flex items-center gap-2">
            <label className={`text-sm px-3 py-2 rounded-lg border border-indigo-300 text-indigo-700 bg-white hover:bg-indigo-50 font-medium cursor-pointer ${parsing ? 'opacity-50 pointer-events-none' : ''}`} title="上传内部成本核算单 Excel,自动填(代码解析,零 token)">
              {parsing ? '解析中…' : '📄 上传报价单'}
              <input type="file" accept=".xlsx,.xls" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); e.currentTarget.value = ''; }} />
            </label>
            <button onClick={save} disabled={saving}
              className="text-sm px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 font-medium disabled:opacity-50">
              {saving ? '冻结中…' : (frozenAt ? '重新冻结' : '冻结报价基线')}
            </button>
          </div>
        )}
      </div>

      {msg && <div className={`rounded-lg px-3 py-2 text-sm ${msg.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>{msg.text}</div>}

      <div className="overflow-x-auto bg-white rounded-xl border border-gray-200">
        <table className="w-full text-sm">
          <thead><tr className="bg-gray-50 text-left text-gray-500 text-xs">
            <th className="px-3 py-2">款号</th><th className="px-3 py-2">物料 *</th><th className="px-3 py-2">类别</th><th className="px-3 py-2">颜色</th>
            <th className="px-3 py-2 text-right">报价单耗</th><th className="px-3 py-2">单位</th>
            {canPrice && <th className="px-3 py-2 text-right">报价单价</th>}
            <th className="px-3 py-2">备注</th>{canEdit && <th className="px-3 py-2"></th>}
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {rows.length === 0 && <tr><td colSpan={canPrice ? 9 : 8} className="px-3 py-6 text-center text-gray-400 text-sm">还没有报价基线,点下方「加一行」逐料录入(或建单时上传报价单自动填)</td></tr>}
            {rows.map((r) => (
              <tr key={r._k}>
                <td className="px-2 py-1"><input disabled={!canEdit} value={r.style_no || ''} onChange={(e) => patch(r._k, { style_no: e.target.value })} placeholder="款号" className="w-20 rounded border border-gray-200 px-2 py-1 text-sm disabled:bg-gray-50" /></td>
                <td className="px-2 py-1"><input disabled={!canEdit} value={r.material_name} onChange={(e) => patch(r._k, { material_name: e.target.value })} placeholder="如 280克直贡呢" className="w-full rounded border border-gray-200 px-2 py-1 text-sm disabled:bg-gray-50" /></td>
                <td className="px-2 py-1">
                  <select disabled={!canEdit} value={r.category || 'fabric'} onChange={(e) => patch(r._k, { category: e.target.value })} className="rounded border border-gray-200 px-2 py-1 text-sm disabled:bg-gray-50">
                    {CATS.map((c) => <option key={c.v} value={c.v}>{c.l}</option>)}
                  </select>
                </td>
                <td className="px-2 py-1"><input disabled={!canEdit} value={r.color || ''} onChange={(e) => patch(r._k, { color: e.target.value })} placeholder="留空=不分色" className="w-24 rounded border border-gray-200 px-2 py-1 text-sm disabled:bg-gray-50" /></td>
                <td className="px-2 py-1 text-right"><input disabled={!canEdit} type="number" inputMode="decimal" value={r.quote_consumption ?? ''} onChange={(e) => patch(r._k, { quote_consumption: e.target.value === '' ? null : Number(e.target.value) })} className="w-24 rounded border border-gray-200 px-2 py-1 text-sm text-right disabled:bg-gray-50" /></td>
                <td className="px-2 py-1"><input disabled={!canEdit} value={r.quote_unit || ''} onChange={(e) => patch(r._k, { quote_unit: e.target.value })} className="w-14 rounded border border-gray-200 px-2 py-1 text-sm disabled:bg-gray-50" /></td>
                {canPrice && <td className="px-2 py-1 text-right"><input disabled={!canEdit} type="number" inputMode="decimal" value={r.quote_unit_price ?? ''} onChange={(e) => patch(r._k, { quote_unit_price: e.target.value === '' ? null : Number(e.target.value) })} className="w-24 rounded border border-gray-200 px-2 py-1 text-sm text-right disabled:bg-gray-50" /></td>}
                <td className="px-2 py-1"><input disabled={!canEdit} value={r.notes || ''} onChange={(e) => patch(r._k, { notes: e.target.value })} className="w-full rounded border border-gray-200 px-2 py-1 text-sm disabled:bg-gray-50" /></td>
                {canEdit && <td className="px-2 py-1 text-center"><button onClick={() => delRow(r._k)} className="text-gray-300 hover:text-rose-500 text-xs" title="删行">✕</button></td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        {canEdit && <button onClick={addRow} className="text-sm px-3 py-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">＋ 加一行</button>}
        {canPrice && (
          <label className="flex items-center gap-2 text-sm text-gray-600">
            加工费(报价·元/件)
            <input disabled={!canEdit} type="number" inputMode="decimal" value={cmt} onChange={(e) => { setCmt(e.target.value); setMsg(null); }} className="w-28 rounded border border-gray-200 px-2 py-1 text-sm text-right disabled:bg-gray-50" />
          </label>
        )}
      </div>

      {!canEdit && <p className="text-xs text-gray-400">仅业务/订单管理/管理员可录入报价基线;你为只读。</p>}
    </div>
  );
}
