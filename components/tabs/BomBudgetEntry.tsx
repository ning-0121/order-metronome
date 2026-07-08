'use client';
// 采购核料 · 业务预算录入(2026-07-08 用户拍板:弃用报价单识别/报价基线,
//   预算改由业务在「采购核料」按真实物料直接填)。给业务的价格录入入口。
// 面料:逐料填【预算单价】,面料预算 = 大货单耗 × 预算单价 × 件数(大货单耗在「原辅料和包装」页填,此处只读)。
// 逐款:填【加工费】+【辅料单件总价】,辅料预算 = 辅料单件总价 × 该款件数。
// 复用已有 server action(saveBomBudgetUnitPrice / saveOrderStyleBudgets),不新建真相源;抛量%仍是采购职权,此处不出现。
import { useEffect, useState } from 'react';
import {
  listBomConsumptionLines, getOrderStyleBudgets,
  saveBomBudgetUnitPrice, saveOrderStyleBudgets,
} from '@/app/actions/procurement-items';

const yuan = (n: number) => `¥${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

export function BomBudgetEntry({ orderId }: { orderId: string }) {
  const [lines, setLines] = useState<any[]>([]);
  const [priceEdit, setPriceEdit] = useState<Record<string, string>>({});
  const [styleBudgets, setStyleBudgets] = useState<Array<{ style_no: string; cmt: string; trim_budget: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  async function load() {
    const [r, sb] = await Promise.all([listBomConsumptionLines(orderId), getOrderStyleBudgets(orderId)]);
    if ((r as any).data) {
      const rows = (r as any).data as any[];
      setLines(rows);
      setPriceEdit(Object.fromEntries(rows.map(l => [l.id, l.budget_unit_price != null ? String(l.budget_unit_price) : ''])));
    }
    if ((sb as any).data) {
      setStyleBudgets(((sb as any).data as any[]).map(b => ({
        style_no: b.style_no,
        cmt: b.cmt != null ? String(b.cmt) : '',
        trim_budget: b.trim_budget != null ? String(b.trim_budget) : '',
      })));
    }
    setLoading(false);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [orderId]);

  async function save() {
    setSaving(true); setMsg('');
    const prices = Object.fromEntries(Object.entries(priceEdit).map(([id, v]) => [id, v === '' ? null : Number(v)]));
    const sbPayload = styleBudgets.map(b => ({
      style_no: b.style_no,
      cmt: b.cmt === '' ? null : Number(b.cmt),
      trim_budget: b.trim_budget === '' ? null : Number(b.trim_budget),
    }));
    const [r1, r2] = await Promise.all([
      saveBomBudgetUnitPrice(orderId, prices as any),
      saveOrderStyleBudgets(orderId, sbPayload as any),
    ]);
    setSaving(false);
    const err = (r1 as any).error || (r2 as any).error;
    if (err) { setMsg('❌ ' + err); return; }
    setMsg('✅ 已保存预算(面料单价 + 逐款加工费/辅料)');
    await load();
  }

  if (loading) return <div className="text-center py-6 text-gray-400 text-sm">加载核料预算…</div>;

  const fabricLines = lines.filter(l => l.required);   // 布料(面料/里料):必填预算单价
  const missing = fabricLines.filter(l => !(Number(priceEdit[l.id]) > 0)).length;

  return (
    <div className="rounded-xl border-2 border-indigo-200 bg-indigo-50/50 p-4 space-y-3 mb-5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-semibold text-gray-800">💰 填报价预算(取代报价单识别)</span>
        {missing > 0
          ? <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">还有 {missing} 条布料未填预算单价</span>
          : <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-medium">✅ 面料预算单价已齐</span>}
        <button onClick={save} disabled={saving}
          className="ml-auto text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50">
          {saving ? '保存中…' : '💾 保存预算'}
        </button>
      </div>
      <p className="text-[11px] text-gray-500">
        面料按<b>采购真实布料</b>逐料填【预算单价】:面料预算 = 大货单耗 × 预算单价 × 件数(大货单耗在「原辅料和包装」页填,此处只读)。
        辅料<b>不逐个填价</b>,在下方逐款填【辅料总价】;逐款再填【加工费】。抛量% 由采购在采购中心填,这里不涉及。
      </p>

      {/* 面料预算单价(只列布料;辅料走下方逐款「辅料总价」) */}
      <div className="overflow-x-auto rounded-lg border border-indigo-100 bg-white">
        <table className="w-full text-xs">
          <thead><tr className="text-left text-gray-400 bg-gray-50/60">
            {['款号', '颜色', '布料', '数量', '大货单耗', '预算单价', '单位', '面料预算(自动)'].map(h => (
              <th key={h} className="py-1.5 px-2 font-medium whitespace-nowrap">{h}</th>
            ))}
          </tr></thead>
          <tbody>
            {fabricLines.map(l => {
              const price = Number(priceEdit[l.id]);
              const cons = Number(l.production_consumption);
              const pcs = Number(l.pieces);
              const budget = l.required && price > 0 && cons > 0 && pcs > 0 ? Math.round(price * cons * pcs * 100) / 100 : null;
              return (
                <tr key={l.id} className={`border-t border-gray-100 ${l.required && !(price > 0) ? 'bg-amber-50/60' : ''}`}>
                  <td className="py-1.5 px-2 font-mono text-gray-700">{l.style_no || '—'}</td>
                  <td className="py-1.5 px-2 text-gray-600">{l.color || '—'}</td>
                  <td className="py-1.5 px-2 text-gray-800">{l.material_name || '—'}
                    {l.required ? <span className="ml-1 text-amber-600">·布料</span> : <span className="ml-1 text-gray-300">·辅料</span>}</td>
                  <td className="py-1.5 px-2 text-gray-700" title="该款×色件数(整单通用辅料=订单总数)">{l.pieces ?? '—'}</td>
                  <td className="py-1.5 px-2">
                    {cons > 0
                      ? <span className="text-gray-800">{l.production_consumption}</span>
                      : l.required ? <span className="text-[11px] text-amber-600" title="到「原辅料和包装」页填大货单耗">未填→</span> : <span className="text-gray-300">—</span>}
                  </td>
                  <td className="py-1.5 px-2 whitespace-nowrap">
                    <span className="text-gray-400 mr-0.5">¥</span>
                    <input type="number" step="any" min="0" value={priceEdit[l.id] ?? ''}
                      placeholder={l.required ? '必填' : '—'}
                      onChange={e => setPriceEdit(prev => ({ ...prev, [l.id]: e.target.value }))}
                      className={`w-20 rounded border px-2 py-1 ${l.required && !(price > 0) ? 'border-amber-300 bg-amber-50' : 'border-gray-300'}`} />
                  </td>
                  <td className="py-1.5 px-2 text-gray-400">{l.unit || '—'}</td>
                  <td className="py-1.5 px-2 font-mono text-indigo-700">{budget != null ? yuan(budget) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 逐款:加工费(元/件) + 辅料总价(该款辅料一口价,不按件数) */}
      {styleBudgets.length > 0 && (
        <div className="rounded-lg border border-indigo-100 bg-white p-3">
          <div className="text-xs font-semibold text-gray-700 mb-1.5">🧵 逐款预算 · 加工费(元/件) + 辅料总价(辅料预算 = 该款辅料总价,不按件数)</div>
          <div className="overflow-x-auto">
            <table className="text-xs">
              <thead><tr className="text-left text-gray-400">
                {['款号', '加工费(元/件)', '辅料总价(元)'].map(h => <th key={h} className="py-1 px-2 font-medium whitespace-nowrap">{h}</th>)}
              </tr></thead>
              <tbody>
                {styleBudgets.map((b, i) => (
                  <tr key={i} className="border-t border-gray-100">
                    <td className="py-1 px-2 font-mono text-gray-700">{b.style_no}</td>
                    <td className="py-1 px-2"><span className="text-gray-400 mr-0.5">¥</span>
                      <input type="number" step="any" min="0" value={b.cmt}
                        onChange={e => setStyleBudgets(sb => sb.map((x, j) => j === i ? { ...x, cmt: e.target.value } : x))}
                        className="w-20 rounded border border-gray-300 px-2 py-1" /></td>
                    <td className="py-1 px-2"><span className="text-gray-400 mr-0.5">¥</span>
                      <input type="number" step="any" min="0" value={b.trim_budget}
                        onChange={e => setStyleBudgets(sb => sb.map((x, j) => j === i ? { ...x, trim_budget: e.target.value } : x))}
                        className="w-24 rounded border border-gray-300 px-2 py-1" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {msg && <p className="text-xs text-gray-600">{msg}</p>}
    </div>
  );
}
