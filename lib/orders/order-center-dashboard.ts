/* eslint-disable @typescript-eslint/no-explicit-any */
import { createClient } from '@/lib/supabase/server';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import { computeOrderStatus } from '@/lib/utils/order-status';
import { isActiveStatus, isBlockedStatus, isDoneStatus, isApprovalPending } from '@/lib/domain/types';
import { getDailyTasks, type DailyTask } from '@/lib/services/daily-tasks.service';
import { getPendingApprovals, type PendingApprovalItem } from '@/lib/services/pending-approvals.service';

export type OrderCenterTone = 'neutral' | 'info' | 'success' | 'warning' | 'risk';

export type OrderCenterKpi = {
  key: string;
  label: string;
  count: number;
  href: string;
  tone: OrderCenterTone;
};

export type OrderCenterStage = {
  key: string;
  label: string;
  count: number;
  percentage: number;
  href: string;
  tone: OrderCenterTone;
};

export type OrderCenterCommandItem = {
  key: string;
  title: string;
  description?: string;
  count?: number;
  severity?: 'info' | 'warning' | 'high' | 'critical';
  href: string;
};

export type OrderCenterDashboard = {
  kpis: OrderCenterKpi[];
  stages: OrderCenterStage[];
  todayTasks: OrderCenterCommandItem[];
  approvals: OrderCenterCommandItem[];
  risks: OrderCenterCommandItem[];
  detailedOrderCount: number;
  generatedAt: string;
};

type SummaryMilestoneRow = {
  id: string;
  name?: string | null;
  step_key: string;
  status: string | null;
  due_at: string | null;
  actual_at?: string | null;
  owner_role?: string | null;
  owner_user_id?: string | null;
  sequence_number?: number | null;
};

type SummaryDelayRequestRow = {
  id?: string;
  status: string | null;
  proposed_new_anchor_date: string | null;
  created_at?: string | null;
};

type SummaryOrderRow = {
  id: string;
  order_no: string;
  internal_order_no: string | null;
  po_number: string | null;
  customer_name: string | null;
  factory_name: string | null;
  incoterm: string | null;
  etd: string | null;
  warehouse_due_date: string | null;
  lifecycle_status: string | null;
  order_type: string | null;
  packaging_type: string | null;
  notes: string | null;
  created_at: string | null;
  style_no: string | null;
  quantity: number | null;
  cancel_date: string | null;
  order_date: string | null;
  factory_date: string | null;
  special_tags?: string[] | null;
  owner_user_id: string | null;
  created_by: string | null;
  milestones: SummaryMilestoneRow[];
  delay_requests: SummaryDelayRequestRow[];
};

export const ORDER_STAGE_DEFINITIONS = [
  {
    key: 'startup',
    label: '启动',
    stepKeys: ['po_confirmed', 'finance_approval', 'order_kickoff_meeting', 'production_order_upload'],
  },
  {
    key: 'conversion',
    label: '转化',
    stepKeys: ['order_docs_bom_complete', 'bulk_materials_confirmed'],
  },
  {
    key: 'sample',
    label: '产前样',
    stepKeys: ['processing_fee_confirmed', 'pre_production_sample_ready', 'pre_production_sample_sent', 'pre_production_sample_approved', 'factory_confirmed'],
  },
  {
    key: 'procurement',
    label: '采购生产',
    stepKeys: ['procurement_order_placed', 'materials_received_inspected', 'production_kickoff', 'pre_production_meeting'],
  },
  {
    key: 'control',
    label: '过程控制',
    stepKeys: ['mid_qc_check', 'final_qc_check'],
  },
  {
    key: 'shipping',
    label: '出货',
    stepKeys: ['packing_method_confirmed', 'factory_completion', 'inspection_release', 'shipping_sample_send'],
  },
  {
    key: 'logistics',
    label: '物流收款',
    stepKeys: ['booking_done', 'customs_export', 'payment_received'],
  },
] as const;

const DONE_LIFECYCLE = new Set(['completed', 'cancelled', 'archived', '已完成', '已取消', '已归档']);
const SHIPPED_STEP_KEYS = new Set(['shipment_execute', 'customs_export', 'booking_done']);

function cnParts(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function getOrderPhaseIndex(order: SummaryOrderRow): number {
  const milestones = order.milestones || [];
  const phases = ORDER_STAGE_DEFINITIONS.map((phase) => {
    const items = milestones.filter((m) => phase.stepKeys.includes(m.step_key));
    const done = items.filter((m) => isDoneStatus(m.status)).length;
    return { ...phase, done, total: items.length, allDone: items.length > 0 && done === items.length };
  });
  const current = phases.find((phase) => !phase.allDone && phase.total > 0);
  if (!current) return ORDER_STAGE_DEFINITIONS.length;
  return ORDER_STAGE_DEFINITIONS.findIndex((phase) => phase.key === current.key);
}

export function getOrderPhaseKey(order: SummaryOrderRow): string {
  const index = getOrderPhaseIndex(order);
  return index >= ORDER_STAGE_DEFINITIONS.length ? 'completed' : ORDER_STAGE_DEFINITIONS[index]!.key;
}

export function getOrderPhaseLabel(order: SummaryOrderRow): string {
  const index = getOrderPhaseIndex(order);
  return index >= ORDER_STAGE_DEFINITIONS.length ? '已完成' : ORDER_STAGE_DEFINITIONS[index]!.label;
}

export function getOrderRiskTone(order: SummaryOrderRow): 'success' | 'warning' | 'risk' {
  const status = computeOrderStatus(order.milestones || []);
  if (status.color === 'RED') return 'risk';
  if (status.color === 'YELLOW') return 'warning';
  return 'success';
}

function isOrderComplete(order: SummaryOrderRow): boolean {
  const milestones = order.milestones || [];
  const allMsDone = milestones.length > 0 && milestones.every((m) => isDoneStatus(m.status));
  return allMsDone || DONE_LIFECYCLE.has(order.lifecycle_status || '');
}

function hasPendingDelay(order: SummaryOrderRow): boolean {
  return (order.delay_requests || []).some((delay) => isApprovalPending(delay.status));
}

function getEffectiveDeliveryDate(order: SummaryOrderRow): string | null {
  const originalDate = order.incoterm === 'DDP' ? order.etd : (order.factory_date || order.etd);
  const approvedDelay = (order.delay_requests || [])
    .filter((d) => d.status === 'approved' && d.proposed_new_anchor_date)
    .sort((a, b) => new Date(b.created_at || '').getTime() - new Date(a.created_at || '').getTime())[0];
  return approvedDelay?.proposed_new_anchor_date || originalDate || null;
}

function isOrderOverdue(order: SummaryOrderRow): boolean {
  if (isOrderComplete(order)) return false;
  if ((order.milestones || []).some((m) => SHIPPED_STEP_KEYS.has(m.step_key) && (String(m.status || '').toLowerCase() === 'done' || isDoneStatus(m.status)))) {
    return false;
  }
  const effectiveDate = getEffectiveDeliveryDate(order);
  if (!effectiveDate) return false;
  const daysOver = Math.ceil((Date.now() - new Date(`${effectiveDate}T23:59:59`).getTime()) / 86400000);
  return daysOver > 0;
}

function mapTaskToCommandItem(task: DailyTask): OrderCenterCommandItem {
  const title = task.title || '今日任务';
  const description = task.description || undefined;
  const count = task.priority === 1 ? 1 : undefined;
  const severity = task.priority === 1 ? 'critical' : 'warning';
  return {
    key: task.id,
    title,
    description,
    count,
    severity,
    href: task.action_url || '/my-today',
  };
}

function mapApprovalToCommandItem(item: PendingApprovalItem): OrderCenterCommandItem {
  return {
    key: item.id,
    title: item.title,
    description: item.subtitle || undefined,
    severity: item.actionable ? 'high' : 'warning',
    href: item.sourceUrl,
  };
}

function mapRiskToCommandItem(order: SummaryOrderRow): OrderCenterCommandItem {
  const overdue = isOrderOverdue(order);
  const riskTone = getOrderRiskTone(order);
  const hasDelay = hasPendingDelay(order);
  const focusedMilestone = (order.milestones || []).find((m) => isBlockedStatus(m.status) || (m.due_at && isActiveStatus(m.status) && new Date(m.due_at).getTime() < Date.now()));
  const overdueDays = getEffectiveDeliveryDate(order)
    ? Math.max(0, Math.ceil((Date.now() - new Date(`${getEffectiveDeliveryDate(order)}T23:59:59`).getTime()) / 86400000))
    : 0;
  const severity = overdue
    ? 'critical'
    : riskTone === 'risk'
      ? 'high'
      : riskTone === 'warning'
        ? 'warning'
        : 'info';
  const badges = [
    overdue ? '已超期' : null,
    hasDelay ? '异常待处理' : null,
  ].filter(Boolean);
  return {
    key: order.id,
    title: order.order_no,
    description: cnParts(
      order.customer_name || undefined,
      focusedMilestone?.name ? `· ${focusedMilestone.name}` : undefined,
      badges.length > 0 ? `· ${badges.join(' / ')}` : undefined,
    ),
    count: overdueDays || undefined,
    severity,
    href: `/orders/${order.id}`,
  };
}

function bucketOrdersByStage(orders: SummaryOrderRow[]): OrderCenterStage[] {
  const stageCounts = new Map<string, number>();
  for (const order of orders) {
    const key = getOrderPhaseKey(order);
    stageCounts.set(key, (stageCounts.get(key) || 0) + 1);
  }
  const total = orders.length || 1;
  const stages: OrderCenterStage[] = [
    ...ORDER_STAGE_DEFINITIONS.map((phase) => {
      const count = stageCounts.get(phase.key) || 0;
      return {
        key: phase.key,
        label: phase.label,
        count,
        percentage: Math.round((count / total) * 100),
        href: `/orders?detail=1&phase=${phase.key}`,
        tone: phase.key === 'startup' ? 'info' : phase.key === 'sample' ? 'warning' : phase.key === 'shipping' ? 'success' : 'neutral',
      };
    }),
    {
      key: 'completed',
      label: '已完成',
      count: orders.filter((order) => isOrderComplete(order)).length,
      percentage: Math.round((orders.filter((order) => isOrderComplete(order)).length / total) * 100),
      href: '/orders?detail=1&status=completed',
      tone: 'success',
    },
  ];
  return stages;
}

function buildKpis(orders: SummaryOrderRow[]): OrderCenterKpi[] {
  const overdue = orders.filter((order) => isOrderOverdue(order)).length;
  const risk = orders.filter((order) => {
    const color = computeOrderStatus(order.milestones || []).color;
    return color === 'RED' || color === 'YELLOW' || hasPendingDelay(order);
  }).length;
  const waitingPo = orders.filter((order) => !isOrderComplete(order) && getOrderPhaseIndex(order) === 0).length;
  const waitingUpload = orders.filter((order) => !isOrderComplete(order) && getOrderPhaseIndex(order) <= 1).length;
  const inProgress = orders.filter((order) => !isOrderComplete(order) && ['sample', 'procurement', 'control'].includes(getOrderPhaseKey(order))).length;
  const waitingShip = orders.filter((order) => !isOrderComplete(order) && ['shipping', 'logistics'].includes(getOrderPhaseKey(order))).length;

  return [
    { key: 'po', label: '待确认 PO', count: waitingPo, href: '/orders?detail=1&phase=startup', tone: 'info' },
    { key: 'upload', label: '待建单', count: waitingUpload, href: '/orders?detail=1&phase=conversion', tone: 'warning' },
    { key: 'active', label: '执行中', count: inProgress, href: '/orders?detail=1&phase=procurement', tone: 'success' },
    { key: 'ship', label: '待出货', count: waitingShip, href: '/orders?detail=1&phase=shipping', tone: 'neutral' },
    { key: 'overdue', label: '已逾期', count: overdue, href: '/risk-orders/overdue', tone: 'risk' },
    { key: 'risk', label: '风险订单', count: risk, href: '/risk-orders/red', tone: 'risk' },
  ];
}

function buildCommandItems(orders: SummaryOrderRow[], todayTasks: DailyTask[], approvals: PendingApprovalItem[]) {
  const today = todayTasks.slice(0, 5).map(mapTaskToCommandItem);
  const approvalItems = approvals.slice(0, 5).map(mapApprovalToCommandItem);
  const riskItems = orders
    .filter((order) => {
      const orderStatus = computeOrderStatus(order.milestones || []);
      return orderStatus.color === 'RED' || orderStatus.color === 'YELLOW' || isOrderOverdue(order) || hasPendingDelay(order);
    })
    .sort((a, b) => {
      const aScore = (isOrderOverdue(a) ? 3 : 0) + (hasPendingDelay(a) ? 2 : 0) + (computeOrderStatus(a.milestones || []).color === 'RED' ? 1 : 0);
      const bScore = (isOrderOverdue(b) ? 3 : 0) + (hasPendingDelay(b) ? 2 : 0) + (computeOrderStatus(b.milestones || []).color === 'RED' ? 1 : 0);
      return bScore - aScore;
    })
    .slice(0, 5)
    .map(mapRiskToCommandItem);

  return { today, approvalItems, riskItems };
}

export function buildOrderCenterDashboard(input: {
  orders: SummaryOrderRow[];
  todayTasks: DailyTask[];
  approvals: PendingApprovalItem[];
  generatedAt?: string;
}): OrderCenterDashboard {
  const orders = input.orders || [];
  const generatedAt = input.generatedAt || new Date().toISOString();
  const stages = bucketOrdersByStage(orders);
  const kpis = buildKpis(orders);
  const { today, approvalItems, riskItems } = buildCommandItems(orders, input.todayTasks || [], input.approvals || []);
  return {
    kpis,
    stages,
    todayTasks: today,
    approvals: approvalItems,
    risks: riskItems,
    detailedOrderCount: orders.length,
    generatedAt,
  };
}

async function getAccessibleOrderIdsForSummary(supabase: any, userId: string, roles: string[]) {
  const isAdmin = roles.includes('admin');
  const canSeeAll = isAdmin || roles.some((r) => ['finance', 'admin_assistant', 'production_manager', 'sales_manager', 'order_manager', 'procurement_manager'].includes(r));

  if (canSeeAll) return null;

  const [ownedOrders, createdOrders, assignedMilestones] = await Promise.all([
    (supabase.from('orders') as any).select('id').eq('owner_user_id', userId),
    (supabase.from('orders') as any).select('id').eq('created_by', userId),
    (supabase.from('milestones') as any).select('order_id').eq('owner_user_id', userId),
  ]);

  const ids = [
    ...(ownedOrders.data || []).map((row: any) => row.id),
    ...(createdOrders.data || []).map((row: any) => row.id),
    ...(assignedMilestones.data || []).map((row: any) => row.order_id),
  ];
  return Array.from(new Set(ids)).filter(Boolean);
}

async function fetchOrderSummaryRows(supabase: any, orderIds: string[] | null) {
  const select = 'id, order_no, internal_order_no, po_number, customer_name, factory_name, incoterm, etd, warehouse_due_date, lifecycle_status, order_type, packaging_type, notes, created_at, style_no, quantity, cancel_date, order_date, factory_date, special_tags, owner_user_id, created_by, milestones(id, name, step_key, status, due_at, actual_at, owner_role, owner_user_id, sequence_number), delay_requests(id, status, proposed_new_anchor_date, created_at)';
  if (Array.isArray(orderIds) && orderIds.length === 0) {
    return { data: [] as SummaryOrderRow[] };
  }
  if (orderIds && orderIds.length > 0) {
    const { data, error } = await (supabase.from('orders') as any)
      .select(select)
      .in('id', orderIds)
      .order('created_at', { ascending: false });
    if (error) return { error: error.message };
    return { data: (data || []) as SummaryOrderRow[] };
  }

  const { data, error } = await (supabase.from('orders') as any)
    .select(select)
    .order('created_at', { ascending: false });
  if (error) return { error: error.message };
  return { data: (data || []) as SummaryOrderRow[] };
}

export async function loadOrderCenterDashboard(): Promise<{ data?: OrderCenterDashboard; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { roles } = await getCurrentUserRole(supabase);
  const accessibleIds = await getAccessibleOrderIdsForSummary(supabase, user.id, roles || []);
  const [ordersRes, tasksRes, approvalsRes] = await Promise.all([
    fetchOrderSummaryRows(supabase, accessibleIds),
    getDailyTasks(supabase, user.id),
    getPendingApprovals(supabase, { userId: user.id, roles: roles || [] }),
  ]);

  if ('error' in ordersRes && ordersRes.error) return { error: ordersRes.error };
  if (!tasksRes.ok) return { error: tasksRes.error };
  if (!approvalsRes.ok) return { error: approvalsRes.error };

  const dashboard = buildOrderCenterDashboard({
    orders: ordersRes.data || [],
    todayTasks: tasksRes.data || [],
    approvals: approvalsRes.data.items || [],
  });

  return { data: dashboard };
}

export const ORDER_CENTER_NAVIGATION = {
  createOrder: '/orders/new',
  workbench: '/orders?detail=1',
  missingInfo: '/my-today',
  riskOrders: '/risk-orders/overdue',
};
