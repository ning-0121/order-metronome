import { createClient } from '@/lib/supabase/server';
import { requireProcurementPage } from '@/lib/utils/procurement-page-guard';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getPurchaseOrder } from '@/app/actions/purchase-orders';
import { PurchaseOrderDetailClient } from './PurchaseOrderDetailClient';

export default async function PODetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireProcurementPage();   // 采购系统页面级门禁:非采购角色回工作台(2026-07-03)
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data, error } = await getPurchaseOrder(id);
  if (error || !data) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-12 text-center text-gray-500">
        <p className="mb-3">{error || '采购单不存在'}</p>
        <Link href="/procurement" className="text-indigo-600 hover:underline">← 采购中心</Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-2"><Link href="/procurement" className="text-sm text-gray-500 hover:text-indigo-600">← 采购中心</Link></div>
      <PurchaseOrderDetailClient view={data} />
    </div>
  );
}
