import type { ProductionCenterSummary, ProductionOrderRow } from '@/app/actions/production-center';
import { classifyProductionTasks, type WorkbenchRole } from '@/lib/production/workbench';

export type DashboardRole = WorkbenchRole | 'executive';
export type DashboardLink = { label: string; description: string; count: number; href: string; severity?: 'critical' | 'high' | 'medium' };
export type DetailedProductionTask = {
  key: string; orderId: string; orderNo: string; customerName: string; href: string;
  title: string; action: string; reasons: string[]; badges: string[]; urgent: boolean;
};

export const PRODUCTION_QUICK_ENTRIES = [
  { title: '排单与派单工作台', subtitle: '生产计划排产与工单派发', icon: '🗓️', href: '/production?workspace=scheduling#scheduling' },
  { title: '工厂排产看板', subtitle: '工厂排产负荷与计划看板', icon: '🏭', href: '/production?workspace=factory#factory' },
  { title: '生产进度录入', subtitle: '生产进度更新与报工录入', icon: '📈', href: '/production?workspace=progress#progress' },
  { title: '风险订单攻克', subtitle: '风险订单跟踪与专项攻克', icon: '🛡️', href: '/production?detail=已超期#details' },
] as const;

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
