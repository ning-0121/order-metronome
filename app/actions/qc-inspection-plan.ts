'use server';

// ============================================================
// QC 巡查计划 —— 跨所有订单,列出未完成的验货节点(中检/尾检/放行),
// 按工厂 + 日期聚合,供 QC(骆姐)排厂巡查。只读,不改任何数据。
//
// 权限:QC / 质量 / 生产主管 / admin。可见性靠 CAN_VIEW_ALL_ORDERS(qc 已在组内),
//   但本页只返回巡查所需字段(订单号/工厂/验货节点/日期),不含价格/客户邮件。
// ============================================================

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';

export interface InspectionItem {
  milestoneId: string;
  stepKey: string;
  nodeName: string;
  layer: 'QC独检' | '业务确认' | '跟单放行';
  orderId: string;
  orderRef: string;          // internal_order_no 优先
  customer: string | null;
  factory: string;           // 未指定 → "未指定工厂"
  dueAt: string | null;
  factoryDate: string | null;
  urgency: 'overdue' | 'soon' | 'later';   // 已过期 / 7 天内 / 更晚
  daysToDue: number | null;
}

export interface FactoryGroup {
  factory: string;
  items: InspectionItem[];
  earliestDue: string | null;
  overdueCount: number;
}

// 节点分层(与 V3 模板一致):中期/尾期验货·QC = QC 独检;业务/放行归其它层,仅供 QC 通盘掌握
const QC_LAYER = new Set(['mid_qc_check', 'final_qc_check']);
const RELEASE_LAYER = new Set(['final_qc_sales_check', 'inspection_release']);

function layerOf(stepKey: string): InspectionItem['layer'] {
  if (QC_LAYER.has(stepKey)) return 'QC独检';
  if (RELEASE_LAYER.has(stepKey)) return '跟单放行';
  return '业务确认';
}

export async function getQcInspectionPlan(nowIso?: string): Promise<{
  groups?: FactoryGroup[];
  summary?: { total: number; overdue: number; soon: number; qcOwn: number };
  error?: string;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { getUserRoles } = await import('@/lib/utils/user-role');
  const roles = await getUserRoles(supabase, user.id);
  const { hasRoleInGroup } = await import('@/lib/domain/roles');
  const allowed = roles.some((r) => ['qc', 'quality', 'admin', 'production_manager'].includes(r)) || hasRoleInGroup(roles, 'CAN_VIEW_ALL_ORDERS');
  if (!allowed) return { error: '仅 QC / 生产主管 / 管理员可查看巡查计划' };

  const svc = createServiceRoleClient();
  const { listPendingInspectionNodes } = await import('@/lib/repositories/milestonesRepo');
  const { data: nodes, error } = await listPendingInspectionNodes(svc);
  if (error) return { error: `读取验货节点失败:${error}` };

  const now = nowIso ? new Date(nowIso) : new Date();
  const DAY = 86400000;
  const items: InspectionItem[] = nodes.map((n) => {
    const due = n.dueAt ? new Date(n.dueAt) : null;
    const days = due ? Math.round((due.getTime() - now.getTime()) / DAY) : null;
    const urgency: InspectionItem['urgency'] = days == null ? 'later' : days < 0 ? 'overdue' : days <= 7 ? 'soon' : 'later';
    return {
      milestoneId: n.id, stepKey: n.stepKey, nodeName: n.name || n.stepKey, layer: layerOf(n.stepKey),
      orderId: n.orderId, orderRef: n.internalNo || n.orderNo || n.orderId.slice(0, 8), customer: n.customer,
      factory: n.factoryName && n.factoryName.trim() ? n.factoryName.trim() : '未指定工厂',
      dueAt: n.dueAt, factoryDate: n.factoryDate, urgency, daysToDue: days,
    };
  });

  // 按工厂聚合,组内按 due 升序;组间按最早 due 升序(最急的工厂排前面)
  const byFactory = new Map<string, InspectionItem[]>();
  for (const it of items) {
    const arr = byFactory.get(it.factory) || [];
    arr.push(it); byFactory.set(it.factory, arr);
  }
  const cmpDue = (a: InspectionItem, b: InspectionItem) => (a.dueAt || '9999').localeCompare(b.dueAt || '9999');
  const groups: FactoryGroup[] = [...byFactory.entries()].map(([factory, its]) => {
    its.sort(cmpDue);
    return { factory, items: its, earliestDue: its[0]?.dueAt ?? null, overdueCount: its.filter((i) => i.urgency === 'overdue').length };
  }).sort((a, b) => (b.overdueCount - a.overdueCount) || (a.earliestDue || '9999').localeCompare(b.earliestDue || '9999'));

  return {
    groups,
    summary: {
      total: items.length,
      overdue: items.filter((i) => i.urgency === 'overdue').length,
      soon: items.filter((i) => i.urgency === 'soon').length,
      qcOwn: items.filter((i) => i.layer === 'QC独检').length,
    },
  };
}
