/**
 * 节点体系 V2 · P1b —— 节点多方确认配置(2026-07-03)
 * 设计:docs/Designs/Milestone-V2-Departments-Redesign.md §二
 *
 * 「节点完成 = 所有要求方确认完毕」:
 *  - 每个 V2 多方节点在此登记要求确认的「方」(部门口径,映射到系统角色组);
 *  - 确认落 milestone_confirmations 表(一节点一方一行,幂等);
 *  - markMilestoneDone 用 requiredPartiesFor() 做完成门禁(缺确认 → 不允许完成);
 *  - 全部确认齐 + 节点不要证据 → 自动完成;要证据 → 提示上传后照常走完成。
 *
 * 部门口径(2026-07-10 归位,取代 2026-07-03 旧口径):
 *  - sales = 业务开发部;merchandiser = 业务执行部(PO确认后接手到出货);
 *  - order_manager = 业务执行经理;sales_manager = 开发业务经理;
 *  - 「业务执行」确认方 = merchandiser(执行) + order_manager(执行经理) + sales_manager(业务经理,跨链)。
 *    ⚠️ 不含 sales(业务开发):产前样/尾查/出运的业务确认应由业务执行侧完成(2026-07-13 用户拍板)。
 *
 * 纯配置+纯函数,无 DB 依赖 → 进 pre-deploy-check 断言。
 */

export interface ConfirmationParty {
  /** 稳定键,存库(milestone_confirmations.party_key),别改 */
  key: string;
  /** 显示名(部门口径) */
  label: string;
  /** 可代表该方确认的系统角色(任一匹配即可;admin 永远可代确认并留痕) */
  roles: string[];
  /** 确认动作的业务含义(UI 副标题) */
  hint?: string;
}

const BIZ_EXEC = ['merchandiser', 'order_manager', 'sales_manager'];   // 业务执行侧(执行+两经理);不含 sales 业务开发
const FINANCE = ['finance'];
const PROCUREMENT = ['procurement', 'procurement_manager'];
/** 生产部(含 QC;跟单 merchandiser 已并入生产部 QC —— 决策①) */
const PRODUCTION_QC = ['production', 'production_manager', 'qc', 'quality', 'merchandiser'];

/**
 * V2 节点 → 要求确认方。不在此表的节点 = 单责任方,走原有完成流程。
 * (mo_released 自动完成;procurement_order_placed / production_kickoff / payment_received 单方)
 */
export const MILESTONE_CONFIRMATION_PARTIES: Record<string, ConfirmationParty[]> = {
  // 1. PO确认 = 财务确认 + 生产部确认(2026-07-06 用户拍板:业务建单即已确认,自己再确认多余;改为财务+生产双确认)
  po_confirmed: [
    { key: 'finance', label: '财务', roles: FINANCE, hint: '价格/账期/额度审核通过' },
    { key: 'production', label: '生产部', roles: PRODUCTION_QC, hint: '订单要求/工艺可执行,已知悉' },
  ],
  // 产前样确认 = 采购(原辅料大货品质) + 业务执行(客户/自确认) 双确认
  pre_production_sample_approved: [
    { key: 'procurement', label: '采购部', roles: PROCUREMENT, hint: '大货原辅料品质与样一致' },
    { key: 'sales_exec', label: '业务执行', roles: BIZ_EXEC, hint: '客户确认/自确认通过' },
  ],
  // 尾期验货业务确认 = 业务执行 + QC 双确认(14 节点模板:业务对尾查结果确认放行)
  final_qc_sales_check: [
    { key: 'qc', label: '生产部QC', roles: PRODUCTION_QC, hint: '尾查合格,问题已闭环' },
    { key: 'sales_exec', label: '业务执行', roles: BIZ_EXEC, hint: '验货结果可对客户交付' },
  ],
  // 8. 发货出运 = 业务执行 + 采购(尾料清点归库) + 财务 三方
  shipment_execute: [
    { key: 'sales_exec', label: '业务执行', roles: BIZ_EXEC, hint: '出运安排/单据齐' },
    { key: 'procurement', label: '采购部', roles: PROCUREMENT, hint: '尾货尾料清点完成并归库' },
    { key: 'finance', label: '财务', roles: FINANCE, hint: '出货前款项条件满足' },
  ],
};

/** 该节点要求的确认方(无 = 单责任方节点)。 */
export function requiredPartiesFor(stepKey: string): ConfirmationParty[] {
  return MILESTONE_CONFIRMATION_PARTIES[stepKey] || [];
}

/** 用户(角色列表)能否代表该方确认。admin 永远可以(代确认,日志留痕)。 */
export function canConfirmParty(userRoles: string[], party: ConfirmationParty): boolean {
  const lower = (userRoles || []).map(r => String(r).toLowerCase());
  if (lower.includes('admin')) return true;
  return party.roles.some(r => lower.includes(r));
}

/** 还差哪些方(给完成门禁/UI 的纯计算)。confirmedKeys = 已确认 party_key 集合。 */
export function pendingParties(stepKey: string, confirmedKeys: Set<string> | string[]): ConfirmationParty[] {
  const set = confirmedKeys instanceof Set ? confirmedKeys : new Set(confirmedKeys);
  return requiredPartiesFor(stepKey).filter(p => !set.has(p.key));
}
