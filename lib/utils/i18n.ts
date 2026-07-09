/**
 * Internationalization utilities for UI labels
 * Only for display text, NOT database values
 */

/**
 * Map role to Chinese label
 */
export function getRoleLabel(role: string): string {
  const roleMap: Record<string, string> = {
    'sales': '业务执行',       // V2 2026-07-03:业务开发在客户开发系统(araos)做到下PO,不进节拍器;节拍器的业务=业务执行部
    'sales_manager': '业务执行经理',
    'merchandiser': '生产部QC',  // V2 决策①:跟单并入生产部 QC 岗
    'order_manager': '订单管理经理',
    'finance': '财务',
    'procurement': '采购',
    'procurement_manager': '采购经理',
    'production': '生产部QC',   // V2:生产部(工厂侧大货跟进 + QC)
    'qc': '生产部QC',          // 质检并入生产部 QC
    'quality': '生产部QC',     // 质检（旧值）并入生产部 QC
    'logistics': '物流/仓库',
    'production_manager': '生产部主管',
    'admin_assistant': '行政督办',
    'admin': '管理员',
  };
  
  return roleMap[role.toLowerCase()] || role;
}

