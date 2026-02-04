import { getOrders } from '@/app/actions/orders';
import Link from 'next/link';
import { formatDate } from '@/lib/utils/date';
import { computeOrderStatus } from '@/lib/utils/order-status';

export default async function OrdersPage() {
  const { data: orders, error } = await getOrders();

  if (error) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="rounded-2xl bg-red-50 border border-red-200 p-6 text-center">
          <p className="text-red-600">加载失败: {error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Page Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">订单列表</h1>
          <p className="mt-1 text-sm text-gray-500">
            共 {orders?.length || 0} 个订单
          </p>
        </div>
        <Link
          href="/orders/new"
          className="btn-primary inline-flex items-center gap-2"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          新建订单
        </Link>
      </div>

      {!orders || orders.length === 0 ? (
        <div className="empty-state rounded-2xl bg-white border border-gray-200">
          <div className="empty-state-icon">📦</div>
          <div className="empty-state-title">暂无订单</div>
          <p className="empty-state-desc mb-6">开始创建您的第一个订单，追踪执行进度</p>
          <Link href="/orders/new" className="btn-primary inline-flex items-center gap-2">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            创建订单
          </Link>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
          <table className="table-modern">
            <thead>
              <tr>
                <th>订单号</th>
                <th>客户</th>
                <th>贸易条款</th>
                <th>ETD/入仓日</th>
                <th>类型</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order: any) => {
                const milestones = (order as any).milestones || [];
                const status = computeOrderStatus(milestones);
                const statusConfig = {
                  GREEN: { label: '正常', class: 'badge-success' },
                  YELLOW: { label: '注意', class: 'badge-warning' },
                  RED: { label: '风险', class: 'badge-danger' },
                }[status.color];

                return (
                  <tr key={order.id}>
                    <td>
                      <span className="font-medium text-gray-900">{order.order_no}</span>
                    </td>
                    <td>
                      <span className="text-gray-700">{order.customer_name}</span>
                    </td>
                    <td>
                      <span className="badge badge-neutral">{order.incoterm}</span>
                    </td>
                    <td>
                      <span className="text-gray-600">
                        {order.incoterm === 'FOB'
                          ? formatDate(order.etd)
                          : formatDate(order.warehouse_due_date)}
                      </span>
                    </td>
                    <td>
                      <span className={`badge ${order.order_type === 'sample' ? 'badge-info' : 'badge-neutral'}`}>
                        {order.order_type === 'sample' ? '样品' : '批量'}
                      </span>
                    </td>
                    <td>
                      <span className={`badge ${statusConfig.class}`}>
                        {statusConfig.label}
                      </span>
                    </td>
                    <td>
                      {order.id ? (
                        <Link
                          href={`/orders/${order.id}`}
                          className="inline-flex items-center gap-1 text-indigo-600 hover:text-indigo-700 font-medium text-sm transition-colors"
                        >
                          查看详情
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                          </svg>
                        </Link>
                      ) : (
                        <span className="text-gray-400 text-sm">-</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
