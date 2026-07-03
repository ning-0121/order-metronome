import { createClient } from '@/lib/supabase/server';
import { requireProcurementPage } from '@/lib/utils/procurement-page-guard';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getProcurementCostSummary } from '@/app/actions/procurement-cost';
import { getOrderLeftover } from '@/app/actions/inventory';
import { ProcurementCostClient } from './ProcurementCostClient';

export default async function ProcurementCostDetailPage({ params }: { params: Promise<{ orderId: string }> }) {
  await requireProcurementPage(['finance']);   // 成本页财务也可看;业务/生产等回工作台(2026-07-03)
  const { orderId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data, error } = await getProcurementCostSummary(orderId);
  const leftover = error ? [] : ((await getOrderLeftover(orderId)).data || []);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-2">
        <Link href="/procurement/cost" className="text-sm text-gray-500 hover:text-indigo-600">← 成本核算</Link>
      </div>
      {error ? (
        <div className="rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-600">{error}</div>
      ) : (
        <ProcurementCostClient data={data} orderId={orderId} leftover={leftover} />
      )}
    </div>
  );
}
