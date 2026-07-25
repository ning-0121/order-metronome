// ============================================================
// 节点改期审批路由(2026-07-05)—— 可配置表,改这里即可调整"谁审谁",不动引擎/UI。
// 按"谁延期(节点 owner_role)"定"审批链(有序角色,逐级点头)"。
// 部门↔角色:业务开发=sales / 业务执行=merchandiser / 业务执行经理=order_manager
//            采购=procurement / 生产=production
// ============================================================

export const DEFERRAL_ROUTING: Record<string, string[]> = {
  procurement:  ['merchandiser', 'order_manager'], // 采购提交 → 业务执行审批 → 业务执行经理审批
  merchandiser: ['sales'],                         // 业务执行延期 → 业务开发确认
  production:   ['production_manager'],            // 生产执行延期 → 生产主管确认可行性
  qc:           ['production_manager'],            // QC 延期 → 生产主管
  logistics:    ['finance', 'order_manager'],      // 出运延期 → 财务把关 → 业务执行经理(2026-07-25 CEO:出运须财务)
  finance:      ['order_manager'],                 // 财务节点延期 → 业务执行经理
  sales:        ['sales_manager'],                 // PO确认(业务开发)延期 → 业务经理
  _default:     ['admin'],                         // 兜底
};

/** 全局延期审批人:可代任一步确认(与 pending-approvals GLOBAL_DELAY_APPROVERS、core CAN_APPROVE_DELAY 对齐)。 */
export const GLOBAL_DELAY_APPROVERS = ['admin', 'order_manager', 'sales_manager'];

/** 取某节点(owner_role)延期的审批链;未配则走 _default。 */
export function deferralChainFor(ownerRole: string | null | undefined): string[] {
  const r = String(ownerRole || '').trim().toLowerCase();
  return DEFERRAL_ROUTING[r] ? [...DEFERRAL_ROUTING[r]] : [...DEFERRAL_ROUTING._default];
}

/** 中文名(通知/展示用)。 */
export const ROLE_CN: Record<string, string> = {
  sales: '业务开发', merchandiser: '业务执行', order_manager: '业务执行经理',
  procurement: '采购', procurement_manager: '采购经理', production: '生产', admin: '管理员',
  finance: '财务', production_manager: '生产主管', sales_manager: '业务经理', qc: '品控', logistics: '物流',
};
export const roleCn = (r: string) => ROLE_CN[r] || r;

/** One authorization source for server actions and button visibility. */
export function canActOnDeferralStep(input: { roles: string[]; requiredRole?: string; actorId?: string; requesterId?: string | null }): boolean {
  // 不能审自己的延期(admin 例外)
  if (input.actorId && input.requesterId && input.actorId === input.requesterId && !input.roles.includes('admin')) return false;
  // 全局审批人(admin/业务执行经理/业务经理)可代任一步 —— 修:此前只认精确 requiredRole,经理在订单页点不了(后端却已放权)。
  if ((input.roles || []).some((r) => GLOBAL_DELAY_APPROVERS.includes(r))) return true;
  return !!input.requiredRole && input.roles.includes(input.requiredRole);
}
