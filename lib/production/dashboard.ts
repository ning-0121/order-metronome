import type { ProductionCenterSummary, ProductionOrderRow } from '@/app/actions/production-center';
import { classifyProductionTasks, type WorkbenchRole } from '@/lib/production/workbench';

export type DashboardRole = WorkbenchRole | 'executive';
export type DashboardLink = { label: string; description: string; count: number; href: string; severity?: 'critical' | 'high' | 'medium' };
export type DetailedProductionTask = {
  key: string; orderId: string; orderNo: string; customerName: string; href: string;
  title: string; action: string; reasons: string[]; badges: string[]; urgent: boolean;
};

export const PRODUCTION_QUICK_ENTRIES = [
  { title: '排单与派单工作台', href: '/production/scheduling' },
  { title: '工厂排产看板', href: '/production/factory-schedule' },
  { title: '生产进度录入', href: '/production/progress' },
  { title: '风险订单攻克', href: '/production?detail=已超期#details' },
] as const;

/**
 * 快捷入口按角色聚焦(2026-07-20 审计:此前对所有角色都发生产主管口径的入口,QC/跟单被无关入口淹没)。
 * 固定 4 个(与图标数组按序对齐)。
 */
export function getQuickEntries(role: DashboardRole): Array<{ title: string; href: string }> {
  if (role === 'qc') return [
    { title: '今日验货', href: '/production?detail=今日验货#details' },
    { title: '待放行', href: '/production?detail=待放行#details' },
    { title: '生产进度录入', href: '/production/progress' },
    { title: '风险订单攻克', href: '/production?detail=已超期#details' },
  ];
  if (role === 'follow_up') return [
    { title: '生产进度录入', href: '/production/progress' },
    { title: '工厂排产看板', href: '/production/factory-schedule' },
    { title: '我的今日任务', href: '/production?detail=all#details' },
    { title: '风险订单攻克', href: '/production?detail=已超期#details' },
  ];
  // supervisor / executive:派单 + 排产 + 录入 + 攻风险
  return [...PRODUCTION_QUICK_ENTRIES];
}

export const STAGE_DEFINITIONS = [
  ['awaiting_procurement', '新订单待采购'], ['materials_in_transit', '物料在途'],
  ['ready_to_schedule', '开生产待排单'], ['in_production', '生产中'],
  ['ready_to_ship', '待发货'], ['completed', '已发货/完成'],
] as const;

export function aggregateDetailedTasks(rows: ProductionOrderRow[], role: WorkbenchRole): DetailedProductionTask[] {
  const byOrder = new Map<string, DetailedProductionTask>();
  for (const row of rows) {
    for (const task of classifyProductionTasks(row, role)) {
      const scope = task.key === 'exception' || task.key === 'overdue' ? 'risk' : task.key;
      const key = `${row.order_id}:${scope}`;
      const existing = byOrder.get(key);
      if (existing) {
        if (!existing.reasons.includes(task.reason)) existing.reasons.push(task.reason);
        if (!existing.badges.includes(task.label)) existing.badges.push(task.label);
        existing.urgent ||= task.urgent;
        continue;
      }
      byOrder.set(key, {
        key, orderId: row.order_id, orderNo: row.internal_order_no || row.order_no || '订单',
        customerName: row.customer_name || '—', href: task.href, title: task.label,
        action: task.action, reasons: [task.reason], badges: [task.label], urgent: task.urgent,
      });
    }
  }
  return [...byOrder.values()].sort((a, b) => Number(b.urgent) - Number(a.urgent) || a.orderNo.localeCompare(b.orderNo));
}

function groupTasks(tasks: DetailedProductionTask[]): DashboardLink[] {
  const groups = new Map<string, DashboardLink>();
  for (const task of tasks) {
    const current = groups.get(task.title);
    if (current) current.count++;
    else groups.set(task.title, { label: task.title, description: task.reasons[0], count: 1, href: `/production?detail=${encodeURIComponent(task.title)}#details` });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 5);
}

export function buildProductionDashboard(rows: ProductionOrderRow[], summary: ProductionCenterSummary, role: DashboardRole) {
  const workbenchRole: WorkbenchRole = role === 'executive' ? 'supervisor' : role;
  const detailed = aggregateDetailedTasks(rows, workbenchRole);
  const today = groupTasks(detailed);
  const approvals: DashboardLink[] = role === 'supervisor' || role === 'executive'
    ? [{ label: '延期申请审批', description: '待审核生产改期及交付影响', count: rows.filter((row) => row.pending_delay).length, href: '/production?detail=延期待审批#details' }].filter((item) => item.count > 0)
    : [];
  const risks: DashboardLink[] = [
    { label: '延期风险订单', description: '生产节点逾期且尚未处置', count: summary.risk, href: '/production?detail=已超期#details', severity: 'critical' },
    { label: '物料短缺风险', description: '仍有物料未下单或未齐套', count: rows.filter((row) => row.material.pending > 0).length, href: '/production?stage=awaiting_procurement#details', severity: 'high' },
    { label: '进度落后预警', description: '在产订单存在逾期生产节点', count: rows.filter((row) => row.stage === 'in_production' && row.risk).length, href: '/production?stage=in_production#details', severity: 'high' },
    { label: '异常停滞订单', description: '风险订单同时存在待审批延期', count: rows.filter((row) => row.risk && row.pending_delay).length, href: '/production?detail=延期待审批#details', severity: 'medium' },
  ].filter((item) => item.count > 0) as DashboardLink[];
  return { today, approvals, risks, detailedCount: detailed.length };
}

export function filterDetailedTasks(tasks: DetailedProductionTask[], query?: string, offset = 0, limit = 25) {
  const normalized = query?.trim().toLowerCase() || '';
  const filtered = normalized ? tasks.filter((task) => [task.orderNo, task.customerName, task.title, ...task.badges]
    .some((value) => value.toLowerCase().includes(normalized))) : tasks;
  return { total: filtered.length, items: filtered.slice(offset, offset + limit), hasMore: offset + limit < filtered.length };
}
