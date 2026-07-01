import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getProcurementCostSummary } from '@/app/actions/procurement-cost';
import { ProcurementCostClient } from './ProcurementCostClient';

export default async function ProcurementCostDetailPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data, error } = await getProcurementCostSummary(orderId);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-2">
        <Link href="/procurement/cost" className="text-sm text-gray-500 hover:text-indigo-600">← 成本核算</Link>
      </div>
      {error ? (
        <div className="rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-600">{error}</div>
      ) : (
        <ProcurementCostClient data={data} orderId={orderId} />
      )}
    </div>
  );
}
