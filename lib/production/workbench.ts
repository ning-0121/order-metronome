import type { ProductionOrderRow } from '@/app/actions/production-center';

export type WorkbenchRole = 'supervisor' | 'follow_up' | 'qc';
export type WorkbenchTask = {
  key: string;
  label: string;
  reason: string;
  action: string;
  href: string;
  urgent: boolean;
};

const today = () => new Date().toISOString().slice(0, 10);

/** Pure projection of existing order/milestone truth; it never persists another status. */
export function classifyProductionTasks(row: ProductionOrderRow, role: WorkbenchRole): WorkbenchTask[] {
  const href = `/production/order/${row.order_id}`;
  const tasks: WorkbenchTask[] = [];
  const add = (key: string, label: string, reason: string, action: string, urgent = false) =>
    tasks.push({ key, label, reason, action, href, urgent });

  if (role === 'supervisor') {
    if (row.stage === 'awaiting_procurement') add('intake', '待生产接单', '订单已进入生产但物料尚未落实', '检查并分配生产跟单');
    if (!row.factory_name) add('factory', '待选工厂', '尚未指定生产工厂', '选择工厂');
    if (row.material.total > 0 && row.material.received < row.material.total) add('material', '待确认物料齐套', `已到 ${row.material.received}/${row.material.total}`, '检查物料风险');
    if (row.stage === 'ready_to_schedule') add('schedule', '待排单', '物料已具备生产排期条件', '进入排产工作台');
    if (row.risk) add('overdue', '已超期', '生产节点已经超过计划日期', '立即处理风险', true);
  } else if (role === 'follow_up') {
    if (!row.factory_name) add('contact_factory', '待联系工厂', '订单尚未选定工厂', '联系并提交工厂选择');
    if (row.stage === 'materials_in_transit') add('material', '待物料齐套', '仍有物料在途或未下单', '更新物料进度');
    if (row.stage === 'ready_to_schedule') add('cutting', '待开裁', '物料齐套、尚未完成开裁', '完成生产启动凭证');
    if (row.stage === 'in_production') add('production', '生产中待跟进', '订单已进入生产阶段', '更新今日进度');
    if (row.risk) add('overdue', '已超期未更新', '计划节点逾期', '更新或申请延期', true);
  } else {
    if (row.stage === 'in_production' && !row.completion) add('inspection', '待中期巡检', '订单生产中且尚未完成质量放行', '进入质量检查');
    if (row.stage === 'ready_to_ship') add('release', '待放行', '生产完成，等待最终质量放行', '提交放行结论');
    if (row.risk) add('qc_overdue', '已超期', '关联生产节点逾期', '检查质量阻塞', true);
  }

  const due = row.kickoff?.due || row.completion?.due;
  if (due === today()) add('today', role === 'qc' ? '今日验货' : '今日需完成', '计划日期为今天', '立即处理', true);
  return tasks;
}

