'use client';
import { useEffect, useState } from 'react';
import { getOrderLines, searchProductVariants, setOrderLineVariant } from '@/app/actions/products';

/** 订单行 ↔ Product Variant 关联(Phase 1b,最小)。把 order_line_items 接到产品。 */
export function ProductVariantPicker({ orderId }: { orderId: string }) {
  const [lines, setLines] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [pickFor, setPickFor] = useState<string | null>(null);  // 正在选变体的 line id
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [msg, setMsg] = useState('');

  const reload = async () => {
    const res = await getOrderLines(orderId);
    if ((res as any).error) setMsg((res as any).error);
    else setLines((res as any).data || []);
    setLoading(false);
  };
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [orderId]);

  useEffect(() => {
    if (!pickFor) return;
    const t = setTimeout(async () => {
      const res = await searchProductVariants(search.trim() || undefined);
      setResults((res as any).data || []);
    }, 250);
    return () => clearTimeout(t);
  }, [search, pickFor]);

  async function assign(lineId: string, variantId: string | null) {
    await setOrderLineVariant(lineId, variantId, orderId);
    setPickFor(null); setSearch(''); await reload();
  }

  if (loading) return <div className="text-gray-400 text-sm py-4">加载中…</div>;
  if (lines.length === 0) return <div className="text-gray-400 text-sm py-4">该订单暂无款色码行(order_line_items 为空)。{msg}</div>;

  return (
    <div className="space-y-2">
      <p className="text-xs text-gray-500">把订单款色码行关联到 Product Variant(产品驱动起点)。普通颜色留行内;变体=市场/客户/构造差异。</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-gray-100 text-left text-gray-500">
            {['款号', '颜色', '尺码', '数量', '关联 Product Variant', ''].map(h => <th key={h} className="py-2 px-2 font-medium whitespace-nowrap">{h}</th>)}
          </tr></thead>
          <tbody>
            {lines.map(l => (
              <tr key={l.id} className="border-b border-gray-50 align-top">
                <td className="py-2 px-2 text-gray-800">{l.style_no || '—'}</td>
                <td className="py-2 px-2 text-gray-600">{[l.color_cn, l.color_en].filter(Boolean).join('/') || '—'}</td>
                <td className="py-2 px-2 text-gray-400 text-xs">{l.sizes && typeof l.sizes === 'object' ? Object.entries(l.sizes).map(([k, v]) => `${k}:${v}`).join(' ') : '—'}</td>
                <td className="py-2 px-2 text-gray-700">{l.qty_pcs ?? '—'}</td>
                <td className="py-2 px-2">
                  {l.variant_label ? <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700">{l.variant_label}</span> : <span className="text-xs text-gray-400">未关联</span>}
                  {pickFor === l.id && (
                    <div className="mt-2 w-72 rounded-lg border border-indigo-200 bg-white p-2">
                      <input autoFocus value={search} onChange={e => setSearch(e.target.value)} placeholder="搜款/客户/国家…" className="w-full rounded border border-gray-300 px-2 py-1 text-xs mb-1" />
                      <div className="max-h-40 overflow-y-auto divide-y">
                        {results.map(r => (
                          <button key={r.id} onClick={() => assign(l.id, r.id)} className="w-full text-left px-2 py-1 text-xs hover:bg-indigo-50">
                            <span className="font-medium text-gray-800">{r.label || '款'}</span> <span className="text-gray-400">· {r.sub}</span>
                          </button>
                        ))}
                        {results.length === 0 && <p className="text-xs text-gray-400 py-1">无变体,先去款库建款+变体。</p>}
                      </div>
                    </div>
                  )}
                </td>
                <td className="py-2 px-2 whitespace-nowrap">
                  {pickFor === l.id
                    ? <button onClick={() => setPickFor(null)} className="text-xs text-gray-500 hover:underline">收起</button>
                    : <button onClick={() => { setPickFor(l.id); setSearch(''); }} className="text-xs text-indigo-600 hover:underline">{l.product_variant_id ? '更换' : '选择'}</button>}
                  {l.product_variant_id && pickFor !== l.id && <button onClick={() => assign(l.id, null)} className="ml-2 text-xs text-red-500 hover:underline">清除</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
