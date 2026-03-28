import { getOrders } from '@/app/actions/orders';
import Link from 'next/link';
import { formatDate } from '@/lib/utils/date';
import { computeOrderStatus } from '@/lib/utils/order-status';

// 阶段进度计算
const PHASE_KEYS = [
  { label: '启动', keys: ['po_confirmed', 'finance_approval', 'production_order_upload'] },
  { label: '转化', keys: ['order_docs_bom_complete', 'bulk_materials_confirmed'] },
  { label: '产前样', keys: ['processing_fee_confirmed', 'pre_production_sample_ready', 'pre_production_sample_sent', 'pre_production_sample_approved', 'factory_confirmed'] },
  { label: '采购生产', keys: ['procurement_order_placed', 'materials_received_inspected', 'production_kickoff', 'pre_production_meeting'] },
  { label: '过程控制', keys: ['mid_qc_check', 'final_qc_check'] },
  { label: '出货', keys: ['packing_method_confirmed', 'factory_completion', 'inspection_release', 'shipping_sample_send'] },
  { label: '物流收款', keys: ['booking_done', 'customs_export', 'payment_received'] },
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

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string }> }) {
  const params = await searchParams;
  const statusFilter = params?.status || 'active';
  const { data: allOrders, error } = await getOrders();

  if (error) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="rounded-2xl bg-red-50 border border-red-200 p-6 text-center">
          <p className="text-red-600">加载失败: {error}</p>
        </div>
      </div>
    );
  }

  // 按状态分组
  const completedOrders = (allOrders || []).filter((o: any) => {
    const ms = o.milestones || [];
    return ms.length > 0 && ms.every((m: any) => _isDone(m.status));
  });
  const activeOrders = (allOrders || []).filter((o: any) => !completedOrders.includes(o));
  const orders = statusFilter === 'completed' ? completedOrders : activeOrders;

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Page Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">订单列表</h1>
          <p className="mt-1 text-sm text-gray-500">
            共 {allOrders?.length || 0} 个订单
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

        {/* 状态筛选 */}
        <div className="flex gap-1 mb-4">
          {[
            { key: 'active', label: '进行中', count: activeOrders.length },
            { key: 'completed', label: '已完成', count: completedOrders.length },
          ].map(tab => (
            <Link
              key={tab.key}
              href={`/orders?status=${tab.key}`}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                statusFilter === tab.key
                  ? 'bg-indigo-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {tab.label} ({tab.count})
            </Link>
          ))}
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
        <>
        {/* Mobile: card layout */}
        <div className="md:hidden space-y-3">
          {orders.map((order: any) => {
            const milestones = (order as any).milestones || [];
            const status = computeOrderStatus(milestones);
            const statusConfig = {
              GREEN: { label: '正常', class: 'bg-green-100 text-green-700' },
              YELLOW: { label: '注意', class: 'bg-yellow-100 text-yellow-700' },
              RED: { label: '风险', class: 'bg-red-100 text-red-700' },
            }[status.color];
            const phases = computePhases(milestones);
            const dateStr = order.incoterm === 'FOB' ? formatDate(order.etd) : formatDate(order.warehouse_due_date);

            return (
              <Link key={order.id} href={`/orders/${order.id}`} className="block bg-white rounded-xl border border-gray-200 p-4 hover:shadow-md transition-shadow active:bg-gray-50">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <div className="font-semibold text-gray-900 text-sm">{order.order_no}</div>
                    <div className="text-xs text-gray-500 mt-0.5">{order.customer_name}{(order as any).factory_name ? ` · ${(order as any).factory_name}` : ''}</div>
                  </div>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${statusConfig.class}`}>{statusConfig.label}</span>
                </div>
                <div className="flex items-center gap-3 text-xs text-gray-500 mb-2">
                  <span>{order.incoterm}</span>
                  <span>{dateStr}</span>
                  <span>{({ trial: '试单', bulk: '正常', repeat: '翻单', urgent: '加急', sample: '样品' }[order.order_type as string] || order.order_type)}</span>
                </div>
                <div className="flex gap-0.5">
                  {phases.map((p: any, i: number) => (
                    <div key={i} className={`h-1.5 flex-1 rounded-sm ${
                      p.allDone ? 'bg-green-500' : p.blocked ? 'bg-orange-400' : p.active ? 'bg-blue-500' : p.done > 0 ? 'bg-blue-200' : 'bg-gray-200'
                    }`} />
                  ))}
                </div>
              </Link>
            );
          })}
        </div>

        {/* Desktop: table layout */}
        <div className="hidden md:block bg-white rounded-2xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
          <table className="table-modern">
            <thead>
              <tr>
                <th>订单号</th>
                <th>客户</th>
                <th>工厂</th>
                <th>款号/PO</th>
                <th>贸易条款</th>
                <th>ETD/ETA</th>
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
                      <span className="text-gray-600">{(order as any).factory_name || '—'}</span>
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
                        {({ trial: '试单', bulk: '正常', repeat: '翻单', urgent: '加急', sample: '样品' }[order.order_type as string] || order.order_type)}
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
                    const currentPhase = phases.find(p => p.active) || phases.find(p => !p.allDone && p.total > 0);
                    const totalDone = milestones.filter((m: any) => _isDone(m.status)).length;
                    const allDone = phases.every(p => p.allDone || p.total === 0);
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
                        <div className="text-xs text-gray-500">
                          {allDone ? (
                            <span className="text-green-600 font-medium">已完成</span>
                          ) : currentPhase ? (
                            <span>{currentPhase.label} <span className="text-gray-400">{totalDone}/{milestones.length}</span></span>
                          ) : (
                            <span className="text-gray-400">{totalDone}/{milestones.length}</span>
                          )}
                        </div>
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
        </div>
        </>
      )}
    </div>
  );
}
