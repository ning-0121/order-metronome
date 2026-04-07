import { createClient } from '@/lib/supabase/server';
import { computeOrderStatus } from '@/lib/utils/order-status';
import { isOverdue } from '@/lib/utils/date';
import { isActiveStatus, isBlockedStatus } from '@/lib/domain/types';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { RiskOrderList } from '@/components/RiskOrderList';

const TYPE_CONFIG: Record<string, { title: string; emoji: string; color: string; description: string }> = {
  red: { title: '红色风险订单', emoji: '🔴', color: 'red', description: '存在严重风险或已逾期超过3天的订单' },
  yellow: { title: '黄色关注订单', emoji: '🟡', color: 'yellow', description: '即将到期或有进度异常的订单' },
  green: { title: '绿色正常订单', emoji: '🟢', color: 'green', description: '所有节点正常推进中的订单' },
  blocked: { title: '阻塞订单', emoji: '🔒', color: 'orange', description: '至少有一个节点处于阻塞状态的订单' },
  overdue: { title: '逾期订单', emoji: '⏰', color: 'red', description: '至少有一个节点已超过截止日期的订单' },
  pending: { title: '待审批延期订单', emoji: '⏳', color: 'blue', description: '有待管理员审批的延期申请' },
};

export default async function RiskOrdersPage({ params }: { params: Promise<{ type: string }> }) {
  const { type } = await params;
  const config = TYPE_CONFIG[type];
  if (!config) notFound();

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // 权限检查：仅管理员
  const { data: profile } = await supabase.from('profiles').select('roles, role').eq('user_id', user.id).single();
  const userRoles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  if (!userRoles.includes('admin')) redirect('/dashboard');

  // 加载所有订单 + 里程碑
  const { data: orders } = await supabase.from('orders').select('*').order('created_at', { ascending: false });
  const ordersWithMilestones: any[] = [];
  if (orders) {
    for (const o of orders as any[]) {
      const { data: milestones } = await supabase.from('milestones').select('*').eq('order_id', o.id);
      ordersWithMilestones.push({ ...o, milestones: milestones || [] });
    }
  }

  // 根据类型过滤
  let filteredOrders: any[] = [];
  if (type === 'red' || type === 'yellow' || type === 'green') {
    const targetColor = type.toUpperCase();
    filteredOrders = ordersWithMilestones.filter(o => {
      const status = computeOrderStatus(o.milestones || []);
      return status?.color === targetColor;
    });
  } else if (type === 'blocked') {
    filteredOrders = ordersWithMilestones.filter(o =>
      (o.milestones || []).some((m: any) => isBlockedStatus(m.status))
    );
  } else if (type === 'overdue') {
    filteredOrders = ordersWithMilestones.filter(o =>
      (o.milestones || []).some((m: any) => isActiveStatus(m.status) && m.due_at && isOverdue(m.due_at))
    );
  } else if (type === 'pending') {
    const { data: pendingDelays } = await (supabase.from('delay_requests') as any)
      .select('milestones!inner(order_id)')
      .eq('status', 'pending');
    const pendingOrderIds = new Set((pendingDelays || []).map((d: any) => d.milestones?.order_id));
    filteredOrders = ordersWithMilestones.filter(o => pendingOrderIds.has(o.id));
  }

  // 为每个订单计算关键统计
  const enriched = filteredOrders.map(o => {
    const milestones = o.milestones || [];
    const overdue = milestones.filter((m: any) => isActiveStatus(m.status) && m.due_at && isOverdue(m.due_at));
    const blocked = milestones.filter((m: any) => isBlockedStatus(m.status));
    const status = computeOrderStatus(milestones);
    // 找到优先处理的节点：阻塞 > 最久逾期
    const focusMilestone = blocked[0] || overdue.sort((a: any, b: any) =>
      new Date(a.due_at).getTime() - new Date(b.due_at).getTime()
    )[0];
    return {
      id: o.id,
      orderNo: o.order_no,
      customerName: o.customer_name || '—',
      factoryName: o.factory_name || '—',
      quantity: o.quantity,
      factoryDate: o.factory_date,
      etd: o.etd,
      lifecycleStatus: o.lifecycle_status,
      overdueCount: overdue.length,
      blockedCount: blocked.length,
      overdueNames: overdue.slice(0, 3).map((m: any) => m.name),
      blockedNames: blocked.slice(0, 3).map((m: any) => m.name),
      riskColor: status?.color || 'GREEN',
      riskReason: status?.reasons?.[0] || '',
      focusMilestoneId: focusMilestone?.id || null,
      focusMilestoneName: focusMilestone?.name || '',
    };
  });

  const colorClasses: Record<string, string> = {
    red: 'bg-red-50 border-red-200 text-red-900',
    yellow: 'bg-yellow-50 border-yellow-200 text-yellow-900',
    green: 'bg-green-50 border-green-200 text-green-900',
    orange: 'bg-orange-50 border-orange-200 text-orange-900',
    blue: 'bg-blue-50 border-blue-200 text-blue-900',
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            {config.emoji} {config.title}
          </h1>
          <p className="mt-1 text-sm text-gray-500">{config.description}</p>
        </div>
        <Link href="/ceo" className="text-sm text-gray-400 hover:text-gray-600">← 返回首页</Link>
      </div>

      <div className={`rounded-xl border p-4 mb-6 ${colorClasses[config.color]}`}>
        <div className="text-3xl font-bold">{enriched.length}</div>
        <div className="text-sm">个订单符合此风险条件</div>
      </div>

      <RiskOrderList orders={enriched} />
    </div>
  );
}
