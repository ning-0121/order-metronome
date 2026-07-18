import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { requireProcurementPage } from '@/lib/utils/procurement-page-guard';
import { ProcurementItemsTab } from '@/components/tabs/ProcurementItemsTab';
import { MoDownloadButton } from './MoDownloadButton';
import { deriveOrderQuantityContext, formatQuantityDisplay } from '@/lib/domain/quantity-engine';

/**
 * 采购专属核料工作页(2026-07-03 用户拍板:采购不进订单详情,防看到/误改订单一切)。
 * 只给:只读订单摘要(双号/客户/数量/交期) + 采购核料 + 生产任务单下载。
 * 订单的编辑、节点、财务等一概不在此页;纯采购角色访问订单详情会被改道到这里。
 */
export default async function ProcurementVerifyPage({ params, searchParams }: { params: Promise<{ orderId: string }>; searchParams: Promise<{ item?: string }> }) {
  const { orderId } = await params;
  const { item: focusItemId } = await searchParams;
  await requireProcurementPage();

  const supabase = await createClient();
  const { data: order } = await (supabase.from('orders') as any)
    .select('id, order_no, internal_order_no, po_number, customer_name, style_no, quantity, etd, factory_date, order_date, lifecycle_status')
    .eq('id', orderId).maybeSingle();
  if (!order) notFound();

  const fmt = (d: any) => (d ? String(d).slice(0, 10) : '—');
  const headItems: Array<[string, any]> = [
    ['客户', order.customer_name],
    ['款号', order.style_no],
    ['数量', order.quantity ? formatQuantityDisplay(deriveOrderQuantityContext({
      physicalQuantity: order.quantity,
      quantityUnit: order.quantity_unit || null,
    })) : null],
    ['下单日', fmt(order.order_date)],
    ['工厂交期', fmt(order.factory_date)],
    ['ETD', fmt(order.etd)],
    ['客户PO', order.po_number],
  ];

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <Link href="/procurement" className="text-sm text-indigo-600 hover:underline">← 采购中心</Link>
          <h1 className="text-2xl font-bold text-gray-900 mt-1">
            🛒 核料 · {order.internal_order_no ? `${order.internal_order_no} | ` : ''}{order.order_no}
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {headItems.filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(' · ')}
          </p>
        </div>
        <MoDownloadButton orderId={order.id} orderNo={order.order_no} />
      </div>

      {/* 订单信息只读;采购的工作面 = 核料确认。带 ?item= 时聚焦到那一款料 */}
      <ProcurementItemsTab orderId={order.id} focusItemId={focusItemId} internalOrderNo={order.internal_order_no} />

      <p className="text-[11px] text-gray-400">
        本页为采购专用工作台:订单资料只读,核料/确认/补采购在此完成;生产任务单点右上下载。订单内容有误请联系业务执行修改。
      </p>
    </div>
  );
}
