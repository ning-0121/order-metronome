import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { NettingClient } from './NettingClient';

// 跨订单合并采购（P3 A）：未归单待下单行按物料跨订单聚合 → 一张跨订单采购单。
export default async function NettingPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-2">
        <Link href="/procurement" className="text-sm text-gray-500 hover:text-indigo-600">← 采购中心</Link>
      </div>
      <h1 className="text-2xl font-bold text-gray-900 mb-1">跨订单合并采购</h1>
      <p className="text-sm text-gray-500 mb-6">未归单待下单行按物料跨订单聚合 → 选一组建一张跨订单采购单(order_ids 自动多订单)。</p>
      <NettingClient />
    </div>
  );
}
