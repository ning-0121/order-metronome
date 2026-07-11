/**
 * 「免验货」— 出货前验货豁免(2026-07-11 用户拍板)。
 *
 * 业务场景:出货前验货节点(成品验货/放行、跟单尾查)默认要一份验货报告(第三方/客户/AQL 抽检)。
 * 但有的单没有这份报告、或客户根本不需要验(内销信任小单 / 客户自验不出报告 / 客户明确免验)。
 * 这时不能硬卡在「需要上传凭证」,也不能乱传文件糊弄 —— 要一个名正言顺的「免验放行」一等状态:
 * 留痕(谁、何时、为什么)+ 打标(风险面板可见)+ 分权(业务/QC 提出免验,QC/生产主管放行)。
 *
 * 复用 orders.special_tags text[] 存标签(无迁移),与 [[color-pending]] 同款范式。
 * 免验的原因写进 order_logs(审计),放行动作写进 milestone 完成日志。
 */

/** 订单级标签:本单免验货(出货前验货节点跳过验货报告凭证)。 */
export const INSPECTION_WAIVED_TAG = '免验货';

/**
 * 「出货前验货」节点 —— 带验货报告凭证要求的节点。本单免验时,这些节点免报告即可放行。
 * 只含出货前的成品验货,不含 mid_qc_check(中查是生产中期内部质检,单独处理)。
 */
export const INSPECTION_STEP_KEYS = ['inspection_release', 'final_qc_check'] as const;

/** 可设置/取消「本单免验货」的角色(业务/QC 都能提出;放行另有更严门禁)。 */
export const CAN_SET_INSPECTION_WAIVER = [
  'sales', 'sales_manager', 'merchandiser', 'order_manager',
  'production', 'qc', 'quality', 'production_manager', 'admin',
] as const;

/**
 * 可「免验放行」(在无验货报告下把出货前验货节点标记完成)的角色。
 * 验货是质量把关 → 归质量口(生产部含 QC)+ 生产主管 + admin。业务不能自己免验自己催的货。
 */
export const CAN_RELEASE_WITHOUT_INSPECTION = [
  'production', 'qc', 'quality', 'production_manager', 'admin',
] as const;

export function isInspectionWaived(
  order: { special_tags?: string[] | null } | null | undefined,
): boolean {
  const tags = Array.isArray(order?.special_tags) ? order!.special_tags! : [];
  return tags.includes(INSPECTION_WAIVED_TAG);
}

/** 该 step_key 是否属于「出货前验货」节点。 */
export function isInspectionStep(stepKey: string | null | undefined): boolean {
  return !!stepKey && (INSPECTION_STEP_KEYS as readonly string[]).includes(stepKey);
}

/** 角色集合与目标角色组是否有交集(admin 恒真)。 */
export function roleAllowed(
  roles: string[] | null | undefined,
  group: readonly string[],
): boolean {
  const rs = (roles || []).map((r) => String(r).toLowerCase());
  if (rs.includes('admin')) return true;
  return rs.some((r) => (group as readonly string[]).includes(r));
}
