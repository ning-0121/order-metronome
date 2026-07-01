import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { listSuppliers } from '@/app/actions/suppliers';
import { listUnassignedProcurementLines } from '@/app/actions/purchase-orders';
import { NewPurchaseOrderClient } from './NewPurchaseOrderClient';

export default async function NewPOPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: suppliers } = await listSuppliers();
  const { data: lines, error } = await listUnassignedProcurementLines();

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-2"><Link href="/procurement" className="text-sm text-gray-500 hover:text-indigo-600">← 采购中心</Link></div>
      <h1 className="text-2xl font-bold text-gray-900 mb-1">新建采购单</h1>
      <p className="text-sm text-gray-500 mb-6">选供应商 + 勾采购项归成一张单;可跨订单。</p>
      {error ? (
        <div className="rounded-xl bg-amber-50 border border-amber-200 p-4 text-sm text-amber-700">{error}</div>
      ) : (
        <NewPurchaseOrderClient suppliers={(suppliers || []) as any[]} lines={(lines || []) as any[]} />
      )}
    </div>
  );
}
