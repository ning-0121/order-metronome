import Link from 'next/link';
import { requireProcurementPage } from '@/lib/utils/procurement-page-guard';
import { listAllPurchaseOrders } from '@/app/actions/purchase-orders';
import { PurchaseOrdersListClient } from './PurchaseOrdersListClient';

export default async function PurchaseOrdersArchivePage() {
  await requireProcurementPage();
  const { data, error } = await listAllPurchaseOrders();

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-2"><Link href="/procurement" className="text-sm text-gray-500 hover:text-indigo-600">← 采购中心</Link></div>
      <h1 className="text-2xl font-bold text-gray-900 mb-1">采购单档案</h1>
      <p className="text-sm text-gray-500 mb-6">全部采购单(含已下单/已收货/已入库的历史单)。订单入库后从队列消失,来这里按订单号/供应商调回。</p>
      {error ? (
        <div className="rounded-xl bg-amber-50 border border-amber-200 p-4 text-sm text-amber-700">{error}</div>
      ) : (
        <PurchaseOrdersListClient pos={(data || []) as any[]} />
      )}
    </div>
  );
}
