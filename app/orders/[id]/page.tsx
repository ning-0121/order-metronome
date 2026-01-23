import { getOrder } from '@/app/actions/orders';
import { getMilestonesByOrder } from '@/app/actions/milestones';
import { getDelayRequestsByOrder } from '@/app/actions/delays';
import { formatDate } from '@/lib/utils/date';
import { OrderTimeline } from '@/components/OrderTimeline';
import { DelayRequestsList } from '@/components/DelayRequestsList';
import { normalizeMilestoneStatus } from '@/lib/domain/types';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getCurrentUserRole } from '@/lib/utils/user-role';

export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { data: order, error: orderError } = await getOrder(id);

  // Debug: Show what we received instead of immediately calling notFound()
  if (orderError || !order) {
    return (
      <div className="p-6 space-y-4">
        <h1 className="text-2xl font-bold text-red-600">Debug: Order Not Found</h1>
        <div className="bg-gray-100 p-4 rounded">
          <p><strong>params.id:</strong> {id}</p>
          <p><strong>orderError:</strong> {orderError || 'null'}</p>
          <p><strong>order:</strong> {order ? JSON.stringify(order, null, 2) : 'null'}</p>
        </div>
        <p className="text-sm text-gray-600">
          If this order should exist, check: 1) RLS policies, 2) Order ID format (must be UUID), 3) Database connection
        </p>
      </div>
    );
  }

  const orderData = order as any;

  // Get current user role and admin status
  const supabase = await createClient();
  const { role: currentRole, isAdmin } = await getCurrentUserRole(supabase);
  const { data: { user } } = await supabase.auth.getUser();
  const isOrderOwner = user ? orderData.created_by === user.id : false;

  const { data: milestones, error: milestonesError } = await getMilestonesByOrder(id);
  const { data: delayRequests, error: delayRequestsError } = await getDelayRequestsByOrder(id);

  // Debug: Show milestones/delayRequests errors if any
  if (milestonesError) {
    console.error('[OrderDetailPage] Milestones error:', milestonesError);
  }
  if (delayRequestsError) {
    console.error('[OrderDetailPage] Delay requests error:', delayRequestsError);
  }

  // 检查所有里程碑是否已完成
  const allMilestonesCompleted = milestones
    ? milestones.every((m: any) => {
        const status = normalizeMilestoneStatus(m.status);
        return status === '已完成';
      })
    : false;

  return (
    <div className="space-y-6 bg-white min-h-screen p-6">
      <div className="bg-white">
        <h1 className="text-3xl font-bold text-gray-900">订单: {orderData.order_no}</h1>
        <p className="text-gray-600 mt-2">客户: {orderData.customer_name}</p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div className="rounded-lg border border-gray-200 bg-white p-6 text-gray-900">
          <h2 className="text-xl font-semibold mb-4 text-gray-900">Order Details</h2>
          <dl className="space-y-2">
            <div>
              <dt className="text-sm font-medium text-gray-600">订单号</dt>
              <dd className="text-sm text-gray-900">{orderData.order_no}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-600">客户</dt>
              <dd className="text-sm text-gray-900">{orderData.customer_name}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-600">贸易条款</dt>
              <dd className="text-sm text-gray-900">{orderData.incoterm}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-600">
                {orderData.incoterm === 'FOB' ? 'ETD' : 'Warehouse Due Date'}
              </dt>
              <dd className="text-sm text-gray-900">
                {orderData.incoterm === 'FOB'
                  ? formatDate(orderData.etd!)
                  : formatDate(orderData.warehouse_due_date!)}
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-600">订单类型</dt>
              <dd className="text-sm text-gray-900">{orderData.order_type === 'sample' ? '样品' : '批量'}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-600">包装类型</dt>
              <dd className="text-sm text-gray-900">
                {orderData.packaging_type === 'standard' ? '标准' : '定制'}
              </dd>
            </div>
            {orderData.notes && (
              <div>
                <dt className="text-sm font-medium text-gray-600">备注</dt>
                <dd className="text-sm text-gray-900">{orderData.notes}</dd>
              </div>
            )}
          </dl>
        </div>
      </div>

      <div className="bg-white">
        <h2 className="text-2xl font-semibold mb-4 text-gray-900">执行时间线</h2>
        {milestonesError ? (
          <div className="text-red-600 bg-red-50 p-3 rounded">Error loading milestones: {milestonesError}</div>
        ) : milestones && milestones.length > 0 ? (
          <OrderTimeline 
            milestones={milestones} 
            orderId={id} 
            orderIncoterm={orderData.incoterm as 'FOB' | 'DDP'}
            currentRole={currentRole}
            isAdmin={isAdmin}
          />
        ) : (
          <p className="text-gray-500 bg-gray-50 p-4 rounded">No milestones found</p>
        )}
      </div>

      {delayRequests && delayRequests.length > 0 && (
        <div className="bg-white">
          <h2 className="text-2xl font-semibold mb-4 text-gray-900">延迟申请</h2>
          <DelayRequestsList delayRequests={delayRequests} orderId={id} isAdmin={isAdmin} isOrderOwner={isOrderOwner} />
        </div>
      )}
    </div>
  );
}
