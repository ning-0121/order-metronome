import { getOrders } from '@/app/actions/orders';
import Link from 'next/link';
import { formatDate } from '@/lib/utils/date';
import { computeOrderStatus } from '@/lib/utils/order-status';

// 阶段进度计算
const PHASE_KEYS = [
  { label: '启动', keys: ['po_confirmed', 'finance_approval', 'production_order_upload', 'production_resources_confirmed'] },
  { label: '转化', keys: ['order_docs_bom_complete', 'bulk_materials_confirmed'] },
  { label: '产前样', keys: ['pre_production_sample_ready', 'pre_production_sample_sent', 'pre_production_sample_approved'] },
  { label: '采购生产', keys: ['procurement_order_placed', 'materials_received_inspected', 'production_kickoff', 'pre_production_meeting'] },
  { label: '过程', keys: ['mid_qc_check', 'final_qc_check'] },
  { label: '出货', keys: ['packing_method_confirmed', 'factory_completion', 'inspection_release', 'shipping_sample_send'] },
  { label: '物流', keys: ['booking_done', 'customs_export', 'payment_received'] },
];
const _isDone = (s: string) => s === 'done' || s === '已完成' || s === 'completed';
const _isActive = (s: string) => s === 'in_progress' || s === '进行中';
const _isBlocked = (s: string) => s === 'blocked' || s === '卡住' || s === '卡单';

function computePhases(milestones: any[]) {
  return PHASE_KEYS.map(phase => {
    const items = milestones.filter(m => phase.keys.includes(m.step_key));
    const done = items.filter(m => _isDone(m.status)).length;
    const active = items.some(m => _isActive(m.status));
    const blocked = items.some(m => _isBlocked(m.status));
    const total = items.length;
    return { ...phase, done, total, active, blocked, allDone: total > 0 && done === total };
  });
}

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

        {/* 搜索框 */}
        <form method="GET" className="flex gap-3 mb-4">
          <input
            type="text"
            name="q"
            placeholder="搜索订单号、客户名、款号..."
            className="flex-1 rounded-xl border border-gray-200 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
          />
          <button
            type="submit"
            className="px-4 py-2 bg-indigo-600 text-white text-sm rounded-xl hover:bg-indigo-700"
          >
            搜索
          </button>
        </form>
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
                <th>款号/PO</th>
                <th>贸易条款</th>
                <th>ETD/入仓日</th>
                <th>类型</th>
                <th>状态</th>
                <th>阶段进度</th>
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
                  <div className="text-sm text-gray-900">{(order as any).style_no || '-'}</div>
                  {(order as any).po_number && <div className="text-xs text-gray-500">{(order as any).po_number}</div>}
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
                  {(() => {
                    const phases = computePhases(milestones);
                    const currentPhase = phases.find(p => p.active);
                    return (
                      <div>
                        <div className="flex gap-0.5 mb-1" title={phases.map(p => `${p.label}: ${p.done}/${p.total}`).join(' | ')}>
                          {phases.map((p, i) => (
                            <div key={i} className={`h-2 flex-1 rounded-sm ${
                              p.allDone ? 'bg-green-500' :
                              p.blocked ? 'bg-orange-400' :
                              p.active ? 'bg-blue-500' :
                              p.done > 0 ? 'bg-blue-200' :
                              'bg-gray-200'
                            }`} />
                          ))}
                        </div>
                        {currentPhase && (
                          <span className="text-xs text-gray-500">{currentPhase.label}</span>
                        )}
                      </div>
                    );
                  })()}
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
