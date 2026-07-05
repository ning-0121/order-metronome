// ============================================================
// 节点改期审批路由(2026-07-05)—— 可配置表,改这里即可调整"谁审谁",不动引擎/UI。
// 按"谁延期(节点 owner_role)"定"审批链(有序角色,逐级点头)"。
// 部门↔角色:业务开发=sales / 业务执行=merchandiser / 业务执行经理=order_manager
//            采购=procurement / 生产=production
// ============================================================

export const DEFERRAL_ROUTING: Record<string, string[]> = {
  procurement:  ['merchandiser', 'order_manager'], // 采购提交 → 业务执行审批 → 业务执行经理审批
  merchandiser: ['sales'],                         // 业务执行延期 → 业务开发确认
  production:   ['merchandiser'],                  // 生产延期 → 业务执行确认
  _default:     ['admin'],                         // 其余(finance/sales 等)→ admin 兜底
};

/** 取某节点(owner_role)延期的审批链;未配则走 _default。 */
export function deferralChainFor(ownerRole: string | null | undefined): string[] {
  const r = String(ownerRole || '').trim().toLowerCase();
  return DEFERRAL_ROUTING[r] ? [...DEFERRAL_ROUTING[r]] : [...DEFERRAL_ROUTING._default];
}

/** 中文名(通知/展示用)。 */
export const ROLE_CN: Record<string, string> = {
  sales: '业务开发', merchandiser: '业务执行', order_manager: '业务执行经理',
  procurement: '采购', procurement_manager: '采购经理', production: '生产', admin: '管理员',
  finance: '财务', production_manager: '生产经理', qc: '品控', logistics: '物流',
};
export const roleCn = (r: string) => ROLE_CN[r] || r;
