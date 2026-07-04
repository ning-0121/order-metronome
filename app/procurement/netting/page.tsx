import { createClient } from '@/lib/supabase/server';
import { requireProcurementPage } from '@/lib/utils/procurement-page-guard';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { NettingClient } from './NettingClient';

// 跨订单合并采购（P3 A）：未归单待下单行按物料跨订单聚合 → 一张跨订单采购单。
export default async function NettingPage() {
  await requireProcurementPage();   // 采购系统页面级门禁:非采购角色回工作台(2026-07-03)
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-2">
        <Link href="/procurement" className="text-sm text-gray-500 hover:text-indigo-600">← 采购中心</Link>
      </div>
      <h1 className="text-2xl font-bold text-gray-900 mb-1">待采购工作台</h1>
      <p className="text-sm text-gray-500 mb-6">未归单待下单行按物料自动分组(同料同色同规格,跨订单)。勾选后:<b className="text-indigo-700">合并需求行</b>(同料并一行)或 <b className="text-emerald-700">归到一张采购单</b>(跨料同供应商一张单)。</p>
      <NettingClient />
    </div>
  );
}
