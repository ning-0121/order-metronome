import { getOrder, getOrderLogs } from '@/app/actions/orders';
import { getMilestonesByOrder } from '@/app/actions/milestones';
import { getDelayRequestsByOrder } from '@/app/actions/delays';
import { formatDate } from '@/lib/utils/date';
import { OrderTimeline } from '@/components/OrderTimeline';
import { DelayRequestsList } from '@/components/DelayRequestsList';
import { normalizeMilestoneStatus } from '@/lib/domain/types';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import Link from 'next/link';
import { OrderDetailTabs } from '@/components/OrderDetailTabs';

export default async function OrderDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab = 'overview' } = await searchParams;

  const { data: order, error: orderError } = await getOrder(id);
  if (orderError || !order) { notFound(); }

  const orderData = order as any;
  const supabase = await createClient();
  const { role: currentRole, isAdmin } = await getCurrentUserRole(supabase);
  const { data: { user } } = await supabase.auth.getUser();
  const isOrderOwner = user ? orderData.created_by === user.id : false;

  const { data: milestones } = await getMilestonesByOrder(id);
  const { data: delayRequests } = await getDelayRequestsByOrder(id);
  const { data: logs } = await getOrderLogs(id);

  const allMilestonesCompleted = milestones
    ? milestones.every((m: any) => normalizeMilestoneStatus(m.status) === '已完成')
    : false;

  // 计算订单整体风险色
  const overdueCount = (milestones || []).filter((m: any) => {
    const status = normalizeMilestoneStatus(m.status);
    return status !== '已完成' && m.due_at && new Date(m.due_at) < new Date();
  }).length;
  const blockedCount = (milestones || []).filter((m: any) => normalizeMilestoneStatus(m.status) === '卡住').length;
  const riskColor = overdueCount > 0 || blockedCount > 0
    ? (overdueCount > 2 || blockedCount > 1 ? 'red' : 'yellow')
    : 'green';
  const riskLabel = { red: '风险', yellow: '注意', green: '正常' }[riskColor];
  const riskClass = { red: 'bg-red-100 text-red-700', yellow: 'bg-yellow-100 text-yellow-700', green: 'bg-green-100 text-green-700' }[riskColor];

  return (
    <div className="min-h-screen bg-gray-50">
      {/* 顶部 Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-7xl mx-auto">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-3 mb-1">
                <Link href="/orders" className="text-sm text-gray-400 hover:text-gray-600">← 订单列表</Link>
              </div>
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-bold text-gray-900">{orderData.order_no}</h1>
                <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${riskClass}`}>{riskLabel}</span>
                {orderData.lifecycle_status && (
                  <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-blue-100 text-blue-700">
                    {orderData.lifecycle_status}
                  </span>
                )}
              </div>
              <p className="text-gray-500 text-sm mt-1">
                {orderData.customer_name}
                {orderData.style_no && <span className="ml-3 text-gray-400">款号：{orderData.style_no}</span>}
                {orderData.po_number && <span className="ml-3 text-gray-400">PO：{orderData.po_number}</span>}
              </p>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <span className="text-gray-400">
                {orderData.incoterm === 'FOB' ? 'ETD' : '入仓日'}：
                <span className="text-gray-700 font-medium">
                  {orderData.incoterm === 'FOB' ? formatDate(orderData.etd) : formatDate(orderData.warehouse_due_date)}
                </span>
              </span>
              {orderData.cancel_date && (
                <span className={`ml-3 text-xs font-medium px-2 py-1 rounded ${new Date(orderData.cancel_date) < new Date() ? 'bg-red-100 text-red-700' : 'bg-orange-100 text-orange-700'}`}>
                  Cancel: {formatDate(orderData.cancel_date)}
                </span>
              )}
            </div>
          </div>

          {/* Tab 导航 */}
          <div className="flex gap-1 mt-4 -mb-px">
            {[
              { key: 'overview', label: '基本信息' },
              { key: 'timeline', label: `执行进度 ${overdueCount > 0 ? '🔴' : blockedCount > 0 ? '🟡' : ''}` },
              { key: 'delays', label: `延期申请 ${delayRequests && delayRequests.length > 0 ? '(' + delayRequests.length + ')' : ''}` },
              { key: 'logs', label: '操作日志' },
            ].map(t => (
              <Link
                key={t.key}
                href={`/orders/${id}?tab=${t.key}`}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  tab === t.key
                    ? 'border-indigo-600 text-indigo-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                {t.label}
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* Tab 内容 */}
      <div className="max-w-7xl mx-auto px-6 py-6">

        {/* Tab: 基本信息 */}
        {tab === 'overview' && (
          <div className="grid gap-6 md:grid-cols-2">
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-4">基础信息</h2>
              <dl className="space-y-3">
                {[
                  { label: '订单号', value: orderData.order_no },
                  { label: '客户', value: orderData.customer_name },
                  { label: '贸易条款', value: orderData.incoterm },
                  { label: orderData.incoterm === 'FOB' ? 'ETD' : '入仓日期', value: orderData.incoterm === 'FOB' ? formatDate(orderData.etd) : formatDate(orderData.warehouse_due_date) },
                  { label: '订单类型', value: orderData.order_type === 'sample' ? '样品' : '批量' },
                  { label: '包装类型', value: orderData.packaging_type === 'standard' ? '标准' : '定制' },
                ].map(({ label, value }) => (
                  <div key={label} className="flex justify-between">
                    <dt className="text-sm text-gray-500">{label}</dt>
                    <dd className="text-sm font-medium text-gray-900">{value || '—'}</dd>
                  </div>
                ))}
              </dl>
            </div>

            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-4">商务信息</h2>
              <dl className="space-y-3">
                {orderData.style_no && <div className="flex justify-between"><dt className="text-sm text-gray-500">款号</dt><dd className="text-sm font-medium text-gray-900">{orderData.style_no}</dd></div>}
                {orderData.po_number && <div className="flex justify-between"><dt className="text-sm text-gray-500">客户PO号</dt><dd className="text-sm font-medium text-gray-900">{orderData.po_number}</dd></div>}
                {orderData.quantity && <div className="flex justify-between"><dt className="text-sm text-gray-500">数量</dt><dd className="text-sm font-medium text-gray-900">{orderData.quantity} 件</dd></div>}
                {orderData.cancel_date && (
                  <div className="flex justify-between">
                    <dt className="text-sm text-gray-500">Cancel Date</dt>
                    <dd className={`text-sm font-medium ${new Date(orderData.cancel_date) < new Date() ? 'text-red-600' : 'text-gray-900'}`}>
                      {formatDate(orderData.cancel_date)}
                    </dd>
                  </div>
                )}
                {orderData.currency && orderData.total_amount && (
                  <div className="flex justify-between">
                    <dt className="text-sm text-gray-500">合同金额</dt>
                    <dd className="text-sm font-medium text-gray-900">{orderData.currency} {orderData.total_amount?.toLocaleString()}</dd>
                  </div>
                )}
                {orderData.payment_terms && <div className="flex justify-between"><dt className="text-sm text-gray-500">付款条件</dt><dd className="text-sm font-medium text-gray-900">{orderData.payment_terms}</dd></div>}
                {orderData.notes && <div className="flex justify-between"><dt className="text-sm text-gray-500">备注</dt><dd className="text-sm font-medium text-gray-900">{orderData.notes}</dd></div>}
                {!orderData.style_no && !orderData.po_number && !orderData.quantity && (
                  <p className="text-sm text-gray-400 text-center py-4">暂无商务信息，可在编辑订单时补充</p>
                )}
              </dl>
            </div>

            {/* 里程碑快速概览 */}
            <div className="md:col-span-2 bg-white rounded-xl border border-gray-200 p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide">进度概览</h2>
                <Link href={`/orders/${id}?tab=timeline`} className="text-sm text-indigo-600 hover:text-indigo-700">查看详情 →</Link>
              </div>
              <div className="grid grid-cols-4 gap-4">
                {[
                  { label: '总节点', value: milestones?.length || 0, color: 'text-gray-700' },
                  { label: '已完成', value: (milestones || []).filter((m: any) => normalizeMilestoneStatus(m.status) === '已完成').length, color: 'text-green-600' },
                  { label: '已超期', value: overdueCount, color: overdueCount > 0 ? 'text-red-600' : 'text-gray-400' },
                  { label: '已阻塞', value: blockedCount, color: blockedCount > 0 ? 'text-orange-600' : 'text-gray-400' },
                ].map(({ label, value, color }) => (
                  <div key={label} className="text-center p-3 rounded-lg bg-gray-50">
                    <div className={`text-2xl font-bold ${color}`}>{value}</div>
                    <div className="text-xs text-gray-500 mt-1">{label}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Tab: 执行进度 */}
        {tab === 'timeline' && (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-6">执行时间线</h2>
            {milestones && milestones.length > 0 ? (
              <OrderTimeline
                milestones={milestones}
                orderId={id}
                orderIncoterm={orderData.incoterm as 'FOB' | 'DDP'}
                currentRole={currentRole}
                isAdmin={isAdmin}
              />
            ) : (
              <p className="text-gray-400 text-center py-8">暂无里程碑数据</p>
            )}
          </div>
        )}

        {/* Tab: 延期申请 */}
        {tab === 'delays' && (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-6">延期申请记录</h2>
            {delayRequests && delayRequests.length > 0 ? (
              <DelayRequestsList
                delayRequests={delayRequests}
                orderId={id}
                isAdmin={isAdmin}
                isOrderOwner={isOrderOwner}
              />
            ) : (
              <p className="text-gray-400 text-center py-8">暂无延期申请</p>
            )}
          </div>
        )}

        {/* Tab: 操作日志 */}
        {tab === 'logs' && (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-6">操作日志</h2>
            {logs && logs.length > 0 ? (
              <div className="space-y-3">
                {(logs as any[]).map((log: any) => (
                  <div key={log.id} className="flex gap-4 p-3 rounded-lg bg-gray-50">
                    <div className="flex-shrink-0 w-2 h-2 rounded-full bg-indigo-400 mt-2" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-gray-900">{log.action}</span>
                        <span className="text-xs text-gray-400 flex-shrink-0">{formatDate(log.created_at)}</span>
                      </div>
                      {log.note && <p className="text-sm text-gray-600 mt-1">{log.note}</p>}
                      {(log.from_status || log.to_status) && (
                        <p className="text-xs text-gray-400 mt-1">
                          {log.from_status} → {log.to_status}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-gray-400 text-center py-8">暂无操作记录</p>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
