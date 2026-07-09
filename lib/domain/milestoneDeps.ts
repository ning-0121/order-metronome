/**
 * 里程碑链内前置依赖(2026-07-09 用户拍板:软门禁)
 *
 * 目的:不能一个人把自己的节点一口气全点完 —— 每个节点有前置,前置没完成时"标完成"会警示。
 * 门禁强度 = **软**:警示 + 二次确认可强行完成(记录原因),符合宪法「系统计算·人决策」。
 *
 * 范围 = 节拍器链内顺序(业务执行 15 节点)。跨系统门禁(布料大货到货→产前样、大货开产→验货)
 * 是下一步(要读采购中心收货 / 生产中心进度),暂不在此。
 *
 * key = 节点 step_key;value = 必须先完成的前置 step_key 列表。
 * 只校验"该订单里实际存在"的前置(被过滤掉的节点如送仓无 booking_done 会自动跳过)。
 */
export const MILESTONE_PREREQUISITES: Record<string, string[]> = {
  pi_confirmed: ['po_confirmed'],
  production_order_upload: ['po_confirmed'],
  order_kickoff_meeting: ['production_order_upload'],
  procurement_order_placed: ['order_kickoff_meeting'],
  pre_production_sample_sent: ['procurement_order_placed'],   // 布料到货(跨系统)是下一步
  pre_production_sample_approved: ['pre_production_sample_sent'],
  mid_qc_sales_check: ['pre_production_sample_approved'],      // 大货开产(跨系统)是下一步
  packing_method_confirmed: ['pre_production_sample_approved'],
  final_qc_sales_check: ['mid_qc_sales_check', 'packing_method_confirmed'],
  shipping_sample_send: ['final_qc_sales_check'],
  ci_made: ['final_qc_sales_check'],
  booking_done: ['ci_made'],
  shipment_execute: ['booking_done', 'ci_made'],              // 送仓无订舱时靠 ci_made 兜底
  payment_received: ['shipment_execute'],
};

/** 该节点未完成的前置(只算该订单里实际存在的前置节点;不存在的前置自动跳过)。 */
export function unmetPrerequisites(
  stepKey: string,
  orderMilestones: Array<{ step_key: string; status: string; name?: string | null }>,
  isDone: (s: string) => boolean,
): Array<{ step_key: string; name: string }> {
  const prereqs = MILESTONE_PREREQUISITES[stepKey] || [];
  if (prereqs.length === 0) return [];
  const byKey = new Map(orderMilestones.map((m) => [m.step_key, m]));
  const unmet: Array<{ step_key: string; name: string }> = [];
  for (const pk of prereqs) {
    const m = byKey.get(pk);
    if (m && !isDone(m.status)) unmet.push({ step_key: pk, name: m.name || pk });
  }
  return unmet;
}
