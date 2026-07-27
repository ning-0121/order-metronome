import Link from 'next/link';
import { getSupervisionOverview, type Tone, type Segment } from '@/app/actions/supervision';

export const dynamic = 'force-dynamic';

const TONE: Record<Tone, string> = {
  green: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  amber: 'bg-amber-50 text-amber-700 border-amber-200',
  red: 'bg-red-50 text-red-700 border-red-200',
  grey: 'bg-gray-50 text-gray-400 border-gray-200',
};
function Pill({ seg }: { seg: Segment }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className={`inline-block w-fit text-xs px-2 py-1 rounded-md border whitespace-nowrap ${TONE[seg.tone]}`}>{seg.label}</span>
      {seg.owner ? <span className="text-[11px] text-gray-500 whitespace-nowrap">👤 {seg.owner}</span> : (seg.tone !== 'grey' && <span className="text-[11px] text-gray-300">未指派</span>)}
    </div>
  );
}

export default async function SupervisionPage() {
  const res = await getSupervisionOverview();

  if (res.error) {
    return (
      <div className="max-w-6xl mx-auto px-4 py-8">
        <div className="rounded-xl bg-red-50 border border-red-200 p-6 text-center text-red-600">{res.error}</div>
      </div>
    );
  }
  const rows = res.rows || [];
  const attn = rows.filter((r) => r.needsAttention).length;

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <div className="flex items-baseline justify-between flex-wrap gap-2 mb-1">
        <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">🧭 督办总览</h1>
        <span className="text-sm text-gray-500">共 {rows.length} 单在产 · <b className="text-red-600">{attn}</b> 单需督办</span>
      </div>
      <p className="text-sm text-gray-500 mb-4">一屏看每单的 <b>业务 / 采购 / 生产</b> 三段进度。<span className="text-red-600">红=卡点需督办</span>、黄=进行中、绿=正常、灰=无该环节。需督办的排在最上。</p>

      <div className="rounded-xl border border-gray-200 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-xs">
            <tr>
              <th className="text-left px-3 py-2.5">订单 / 客户 / 工厂</th>
              <th className="text-left px-3 py-2.5">下单日</th>
              <th className="text-right px-3 py-2.5">数量</th>
              <th className="text-left px-3 py-2.5">出厂日</th>
              <th className="text-left px-3 py-2.5">业务段</th>
              <th className="text-left px-3 py-2.5">采购段</th>
              <th className="text-left px-3 py-2.5">生产段</th>
              <th className="px-3 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.order_id} className={`border-t border-gray-100 ${r.needsAttention ? 'bg-red-50/40' : ''}`}>
                <td className="px-3 py-2.5">
                  <div className="font-medium text-gray-900">{r.internal_order_no || r.order_no || '—'}</div>
                  <div className="text-xs text-gray-500">{r.customer_name || '—'} · {r.factory_name || '未指定'}</div>
                </td>
                <td className="px-3 py-2.5 text-gray-700 whitespace-nowrap">{r.order_date || '—'}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-gray-700">{r.quantity != null ? r.quantity.toLocaleString() : '—'}</td>
                <td className="px-3 py-2.5 text-gray-700 whitespace-nowrap">{r.factory_date || '—'}</td>
                <td className="px-3 py-2.5"><Pill seg={r.business} /></td>
                <td className="px-3 py-2.5"><Pill seg={r.procurement} /></td>
                <td className="px-3 py-2.5"><Pill seg={r.production} /></td>
                <td className="px-3 py-2.5 text-right">
                  <Link href={`/orders/${r.order_id}`} className="text-xs text-indigo-600 hover:underline whitespace-nowrap">详情 ›</Link>
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8} className="px-3 py-10 text-center text-gray-400">当前无在产订单。</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
