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
    if (row.stage === 'awaiting_procurement' && !row.production_follow_up_id) add('intake', '待生产接单', '订单已由业务交接、尚未完成生产接单', '检查订单并接单');
    if (!row.production_follow_up_id) add('assign', '待分配生产跟单', '尚未指定生产跟单', '指定在职生产跟单');
    else if (!row.factory_name) add('assigned', '已分配待跟进', `已分配给 ${row.production_follow_up_name || '生产跟单'}`, '督促选择工厂');
    if (!row.factory_name) add('factory', '待选工厂', '尚未指定生产工厂', '选择工厂');
    if (row.pending_delay) add('delay', '延期待审批', '存在待处理生产改期申请', '审核生产执行影响');
    if (row.risk) add('exception', '异常待处理', '生产节点已超期或存在执行风险', '处理异常并明确责任人', true);
    if (row.kickoff?.due === today() && row.kickoff.status !== 'done') add('cut_today', '今日应开裁', '生产启动计划日期为今天', '完成开裁确认', true);
    if (row.stage === 'in_production' && row.kickoff?.due === today()) add('online_today', '今日应上线', '开裁节点今天到期且订单进入生产', '确认上线状态', true);
    if (row.risk) add('overdue', '已超期', '生产节点已经超过计划日期', '立即处理风险', true);
  } else if (role === 'follow_up') {
    if (row.production_follow_up_id) add('new_assignment', '新分配订单', '生产主管已分配本单', '确认接单并联系工厂');
    if (!row.factory_name) add('contact_factory', '工厂待确认沟通', '工厂尚未由生产主管最终确认', '沟通并提交工厂建议');
    if (row.stage === 'materials_in_transit') add('material', '待物料齐套', '仍有物料在途或未下单', '更新物料进度');
    if (row.stage === 'ready_to_schedule') add('cutting', '待开裁', '物料齐套、尚未完成开裁', '完成生产启动凭证');
    if (row.stage === 'in_production') {
      add('production', '生产中待更新', '订单已进入生产阶段', '更新今日进度');
      add('first_piece', '待首件', '上线后需保留首件质量证据', '提交首件记录');
      add('inline_qc', '待中查', '生产中需完成过程质量检查', '提交中查报告');
    }
    if (row.stage === 'ready_to_ship') {
      add('final_qc', '待尾查', '工厂完成前需最终质量检查', '提交尾查/复检结论');
      add('packing', '待包装', '质量放行后需跟进包装', '确认包装与箱唛');
      add('shipment_follow_up', '待出货跟进', '生产跟单责任持续到工厂侧出货完成', '跟进装运并上传凭证');
    }
    if (row.risk) add('overdue', '已超期未更新', '计划节点逾期', '更新或申请延期', true);
  } else {
    if (row.stage === 'in_production' && !row.completion) add('inspection', '待中期巡检', '订单生产中且尚未完成质量放行', '进入质量检查');
    if (row.stage === 'ready_to_ship') add('release', '待放行', '生产完成，等待最终质量放行', '提交放行结论');
    if (row.risk) add('qc_overdue', '已超期', '关联生产节点逾期', '检查质量阻塞', true);
  }

  const due = row.kickoff?.due || row.completion?.due;
  if (role !== 'supervisor' && due === today()) add('today', role === 'qc' ? '今日验货' : '今日需完成', '计划日期为今天', '立即处理', true);
  return tasks;
}
