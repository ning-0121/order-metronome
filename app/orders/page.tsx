import { getOrders } from '@/app/actions/orders';
import Link from 'next/link';
import { formatDate } from '@/lib/utils/date';
import { computeOrderStatus } from '@/lib/utils/order-status';

export default async function OrdersPage() {
  const { data: orders, error } = await getOrders();

  if (error) {
    return <div className="text-red-600">Error: {error}</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">订单列表</h1>
        <Link
          href="/orders/new"
          className="rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
        >
          新建订单
        </Link>
      </div>

      {!orders || orders.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center">
          <p className="text-gray-500">暂无订单</p>
          <Link
            href="/orders/new"
            className="mt-4 inline-block text-blue-600 hover:text-blue-700"
          >
            创建第一个订单
          </Link>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse border border-gray-300">
            <thead>
              <tr className="bg-gray-100">
                <th className="border border-gray-300 px-4 py-2 text-left">订单号</th>
                <th className="border border-gray-300 px-4 py-2 text-left">客户</th>
                <th className="border border-gray-300 px-4 py-2 text-left">贸易条款</th>
                <th className="border border-gray-300 px-4 py-2 text-left">ETD/入仓日</th>
                <th className="border border-gray-300 px-4 py-2 text-left">类型</th>
                <th className="border border-gray-300 px-4 py-2 text-left">状态</th>
                <th className="border border-gray-300 px-4 py-2 text-left">操作</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order: any) => (
                <tr key={order.id} className="hover:bg-gray-50">
                  <td className="border border-gray-300 px-4 py-2">{order.order_no}</td>
                  <td className="border border-gray-300 px-4 py-2">{order.customer_name}</td>
                  <td className="border border-gray-300 px-4 py-2">{order.incoterm}</td>
                  <td className="border border-gray-300 px-4 py-2">
                    {order.incoterm === 'FOB'
                      ? formatDate(order.etd)
                      : formatDate(order.warehouse_due_date)}
                  </td>
                  <td className="border border-gray-300 px-4 py-2">
                    {order.order_type === 'sample' ? '样品' : '批量'}
                  </td>
                  <td className="border border-gray-300 px-4 py-2">
                    {(() => {
                      const milestones = (order as any).milestones || [];
                      const status = computeOrderStatus(milestones);
                      const colorClass = {
                        GREEN: 'bg-green-100 text-green-800',
                        YELLOW: 'bg-yellow-100 text-yellow-800',
                        RED: 'bg-red-100 text-red-800',
                      }[status.color];
                      return (
                        <span className={`px-2 py-1 rounded text-xs font-semibold ${colorClass}`}>
                          {status.color === 'GREEN' ? '正常' : status.color === 'YELLOW' ? '注意' : '风险'}
                        </span>
                      );
                    })()}
                  </td>
                  <td className="border border-gray-300 px-4 py-2">
                    {order.id ? (
                      <Link
                        href={`/orders/${order.id}`}
                        className="text-blue-600 hover:text-blue-700"
                      >
                        查看
                      </Link>
                    ) : (
                      <span className="text-gray-400 text-sm">无ID</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
