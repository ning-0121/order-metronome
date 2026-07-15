'use server';

/**
 * 物流工作台(2026-07-13):物流部(秦增超)收到财务放货后,安排送仓/装柜/内陆送货。
 * 待发货队列口径:order_financials.allow_shipment=true(财务已放货)且 出运节点(出口=shipment_execute /
 *   国内=domestic_delivery)尚未完成 且 订单未终态。robust:不依赖通知,直接按放货闸+节点状态算。
 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isDoneStatus } from '@/lib/domain/types';
import { isTerminalLifecycle } from '@/lib/domain/lifecycleStatus';
import { hasRoleInGroup } from '@/lib/domain/roles';

export interface LogisticsShipItem {
  orderId: string;
  orderNo: string;
  internalNo: string | null;
  customer: string | null;
  isDomestic: boolean;          // 国内送仓 vs 出口装柜出运
  wayLabel: string;             // 出运方式标签
  deadline: string | null;      // 交期(factory_date)
  daysToDeadline: number | null;
  shipNodeName: string;         // 当前待办出运节点名
  shipNodeStatus: string;
  bookingDone: boolean;         // 订舱是否完成(出口)
  docsReady: boolean;           // 出货单据(装箱单)是否已出
}

const SHIP_STEP_EXPORT = 'shipment_execute';
const SHIP_STEP_DOMESTIC = 'domestic_delivery';

/** 物流待发货队列:已放货、待出运/待送仓的订单。物流/管理/生产管理可见。 */
export async function getLogisticsShipQueue(): Promise<{ data?: LogisticsShipItem[]; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data: prof } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (prof as any)?.roles?.length ? (prof as any).roles : [(prof as any)?.role].filter(Boolean);
  if (!(roles.includes('logistics') || roles.includes('admin') || roles.includes('production_manager') || hasRoleInGroup(roles, 'CAN_SEE_ALL_ORDERS'))) {
    return { error: '无权查看物流工作台' };
  }

  const svc = createServiceRoleClient();
  // 1) 已放货订单
  const { data: fin } = await (svc.from('order_financials') as any)
    .select('order_id, allow_shipment').eq('allow_shipment', true);
  const releasedIds = [...new Set(((fin || []) as any[]).map((f) => f.order_id).filter(Boolean))] as string[];
  if (!releasedIds.length) return { data: [] };

  // 2) 订单基础(过滤终态)
  const { data: orders } = await (svc.from('orders') as any)
    .select('id, order_no, internal_order_no, customer_name, delivery_type, incoterm, factory_date, lifecycle_status')
    .in('id', releasedIds);
  const activeOrders = ((orders || []) as any[]).filter((o) => !isTerminalLifecycle(o.lifecycle_status));
  if (!activeOrders.length) return { data: [] };
  const oIds = activeOrders.map((o) => o.id);

  // 3) 出运相关里程碑
  const { data: ms } = await (svc.from('milestones') as any)
    .select('order_id, step_key, name, status')
    .in('order_id', oIds)
    .in('step_key', [SHIP_STEP_EXPORT, SHIP_STEP_DOMESTIC, 'booking_done', 'customs_export']);
  const msByOrder = new Map<string, any[]>();
  for (const m of (ms || []) as any[]) {
    const arr = msByOrder.get(m.order_id) || []; arr.push(m); msByOrder.set(m.order_id, arr);
  }

  // 4) 出货单据是否已出(packing_lists 存在即视为已生成装箱单)
  const { data: pls } = await (svc.from('packing_lists') as any).select('order_id').in('order_id', oIds);
  const docsByOrder = new Set(((pls || []) as any[]).map((p) => p.order_id));

  const now = Date.now();
  const out: LogisticsShipItem[] = [];
  for (const o of activeOrders) {
    const nodes = msByOrder.get(o.id) || [];
    const domesticNode = nodes.find((m) => m.step_key === SHIP_STEP_DOMESTIC);
    const exportNode = nodes.find((m) => m.step_key === SHIP_STEP_EXPORT);
    const isDomestic = !!domesticNode || o.delivery_type === 'domestic';
    const shipNode = isDomestic ? (domesticNode || exportNode) : (exportNode || domesticNode);
    if (!shipNode) continue;                       // 无出运节点(打样单等)→ 不在物流队列
    if (isDoneStatus(shipNode.status)) continue;   // 已出运/已送仓 → 离队
    const booking = nodes.find((m) => m.step_key === 'booking_done');
    const deadline = o.factory_date || null;
    const daysToDeadline = deadline ? Math.ceil((new Date(deadline + 'T23:59:59').getTime() - now) / 86400000) : null;
    out.push({
      orderId: o.id, orderNo: o.order_no, internalNo: o.internal_order_no, customer: o.customer_name,
      isDomestic, wayLabel: isDomestic ? '国内送仓' : `出口出运${o.incoterm ? `(${o.incoterm})` : ''}`,
      deadline, daysToDeadline,
      shipNodeName: shipNode.name, shipNodeStatus: shipNode.status,
      bookingDone: booking ? isDoneStatus(booking.status) : false,
      docsReady: docsByOrder.has(o.id),
    });
  }
  // 交期近的在前
  out.sort((a, b) => (a.daysToDeadline ?? 9999) - (b.daysToDeadline ?? 9999));
  return { data: out };
}
