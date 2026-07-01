import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { listOrdersWithProcurement } from '@/app/actions/procurement-cost';

// 采购成本核算入口：有采购行的订单列表 → 选一个看核算。
export default async function ProcurementCostIndexPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: orders, error } = await listOrdersWithProcurement();

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-2">
        <Link href="/procurement" className="text-sm text-gray-500 hover:text-indigo-600">← 采购中心</Link>
      </div>
      <h1 className="text-2xl font-bold text-gray-900 mb-1">采购成本核算</h1>
      <p className="text-sm text-gray-500 mb-6">选订单 → 实际采购成本 vs 预算 · 订收差异 · 一键回填利润</p>

      {error ? (
        <div className="rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-600">{error}</div>
      ) : !orders || orders.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-gray-200 p-12 text-center text-sm text-gray-400">暂无采购数据的订单</div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
          {orders.map((o: any) => (
            <Link key={o.id} href={`/procurement/cost/${o.id}`}
              className="flex items-center justify-between px-4 py-3 hover:bg-gray-50 text-sm">
              <span className="text-gray-800">{o.internal_order_no || o.order_no} · {o.customer_name || '—'}</span>
              <span className="text-gray-400 text-xs">{o.lifecycle_status || ''} →</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
