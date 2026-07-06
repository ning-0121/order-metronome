// 预算 vs 实际 四列对照(2026-07-05)——逐物料 预算/实际下单/实际送货/尾料剩余,
// 每组 数量·单价·总额;实际下单哪项超预算标红。纯展示,服务端渲染。

type Cell = { qty: number | null; price?: number | null; total: number | null;
  over_qty?: boolean; over_price?: boolean; over_total?: boolean };
interface Row { material_name: string; color?: string | null; unit: string | null; budget: Cell; ordered: Cell; received: Cell; leftover: Cell }

const n = (v: number | null | undefined, dash = '—') => (v == null ? dash : (Math.round(v * 1000) / 1000).toLocaleString());
const red = (on?: boolean) => (on ? 'text-red-600 font-semibold' : '');

export function BudgetVsActualTable({ data }: { data: { rows: Row[]; totals: any; orderQty: number; has_budget: boolean } }) {
  const { rows, totals, orderQty, has_budget } = data;
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2 flex-wrap">
        <span className="text-sm font-semibold text-gray-800">📊 预算 vs 实际(逐物料)</span>
        <span className="text-xs text-gray-400">预算来自报价单(单件用量 × 订单 {orderQty} 件)· 实际下单超预算标红</span>
        {!has_budget && <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-700">⚠ 该单未录报价基线,预算列为空</span>}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs whitespace-nowrap">
          <thead>
            <tr className="text-gray-500 border-b border-gray-100">
              <th rowSpan={2} className="text-left py-2 px-3 font-medium align-bottom">物料</th>
              <th colSpan={3} className="py-1.5 px-2 font-medium text-center border-l border-gray-100 bg-gray-50">预算</th>
              <th colSpan={3} className="py-1.5 px-2 font-medium text-center border-l border-gray-100 bg-indigo-50/50">实际下单</th>
              <th colSpan={2} className="py-1.5 px-2 font-medium text-center border-l border-gray-100 bg-sky-50/50">实际送货</th>
              <th colSpan={2} className="py-1.5 px-2 font-medium text-center border-l border-gray-100 bg-emerald-50/50">尾料剩余</th>
            </tr>
            <tr className="text-gray-400 border-b border-gray-100 text-[11px]">
              <th className="py-1 px-2 font-normal text-right border-l border-gray-100">数量</th><th className="py-1 px-2 font-normal text-right">单价</th><th className="py-1 px-2 font-normal text-right">总额</th>
              <th className="py-1 px-2 font-normal text-right border-l border-gray-100">数量</th><th className="py-1 px-2 font-normal text-right">单价</th><th className="py-1 px-2 font-normal text-right">总额</th>
              <th className="py-1 px-2 font-normal text-right border-l border-gray-100">数量</th><th className="py-1 px-2 font-normal text-right">总额</th>
              <th className="py-1 px-2 font-normal text-right border-l border-gray-100">数量</th><th className="py-1 px-2 font-normal text-right">总额</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={11} className="py-6 text-center text-gray-400">暂无采购数据</td></tr>
            ) : rows.map((r, i) => (
              <tr key={i} className="border-b border-gray-50">
                <td className="py-2 px-3 text-gray-800">
                  {r.material_name}
                  {r.color && <span className="ml-1.5 text-[11px] px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 align-middle">{r.color}</span>}
                  {r.unit ? <span className="text-gray-400"> ({r.unit})</span> : ''}
                </td>
                {/* 预算 */}
                <td className="py-2 px-2 text-right text-gray-500 border-l border-gray-100">{n(r.budget.qty)}</td>
                <td className="py-2 px-2 text-right text-gray-500">{n(r.budget.price)}</td>
                <td className="py-2 px-2 text-right text-gray-600">{n(r.budget.total)}</td>
                {/* 实际下单(超预算标红) */}
                <td className={`py-2 px-2 text-right border-l border-gray-100 ${red(r.ordered.over_qty)}`}>{n(r.ordered.qty)}{r.ordered.over_qty ? ' ▲' : ''}</td>
                <td className={`py-2 px-2 text-right ${red(r.ordered.over_price)}`}>{n(r.ordered.price)}{r.ordered.over_price ? ' ▲' : ''}</td>
                <td className={`py-2 px-2 text-right font-medium ${red(r.ordered.over_total)}`}>{n(r.ordered.total)}{r.ordered.over_total ? ' ▲' : ''}</td>
                {/* 实际送货 */}
                <td className="py-2 px-2 text-right text-gray-600 border-l border-gray-100">{n(r.received.qty)}</td>
                <td className="py-2 px-2 text-right text-gray-600">{n(r.received.total)}</td>
                {/* 尾料剩余 */}
                <td className="py-2 px-2 text-right text-gray-600 border-l border-gray-100">{n(r.leftover.qty)}</td>
                <td className="py-2 px-2 text-right text-gray-600">{n(r.leftover.total)}</td>
              </tr>
            ))}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-gray-200 font-semibold text-gray-800">
                <td className="py-2 px-3">合计</td>
                <td colSpan={2} className="py-2 px-2 text-right text-gray-400 border-l border-gray-100">总额→</td>
                <td className="py-2 px-2 text-right">{n(totals.budget)}</td>
                <td colSpan={2} className="py-2 px-2 text-right text-gray-400 border-l border-gray-100">总额→</td>
                <td className={`py-2 px-2 text-right ${totals.ordered > totals.budget && totals.budget > 0 ? 'text-red-600' : ''}`}>{n(totals.ordered)}{totals.ordered > totals.budget && totals.budget > 0 ? ' ▲' : ''}</td>
                <td className="py-2 px-2 text-right text-gray-400 border-l border-gray-100">总额→</td>
                <td className="py-2 px-2 text-right">{n(totals.received)}</td>
                <td className="py-2 px-2 text-right text-gray-400 border-l border-gray-100">总额→</td>
                <td className="py-2 px-2 text-right">{n(totals.leftover)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
