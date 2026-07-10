import Link from 'next/link';
import { requireProcurementPage } from '@/lib/utils/procurement-page-guard';
import { listAllPurchaseOrders } from '@/app/actions/purchase-orders';
import { PurchaseOrdersListClient } from './PurchaseOrdersListClient';
import { ProcurementLedgerExport } from '@/components/procurement/ProcurementLedgerExport';

export default async function PurchaseOrdersArchivePage() {
  await requireProcurementPage();
  const { data, error } = await listAllPurchaseOrders();

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-2"><Link href="/procurement" className="text-sm text-gray-500 hover:text-indigo-600">← 采购中心</Link></div>
      <div className="flex items-start justify-between gap-4 flex-wrap mb-1">
        <h1 className="text-2xl font-bold text-gray-900">采购单档案</h1>
        <ProcurementLedgerExport />
      </div>
      <p className="text-sm text-gray-500 mb-6">全部采购单(含已下单/已收货/已入库的历史单)。订单入库后从队列消失,来这里按订单号/供应商调回。右上角可按时间段导出「采购流水」(供应商×面辅料,月度对账)。</p>
      {error ? (
        <div className="rounded-xl bg-amber-50 border border-amber-200 p-4 text-sm text-amber-700">{error}</div>
      ) : (
        <PurchaseOrdersListClient pos={(data || []) as any[]} />
      )}
    </div>
  );
}
