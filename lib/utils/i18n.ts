/**
 * Internationalization utilities for UI labels
 * Only for display text, NOT database values
 */

/**
 * Map role to Chinese label
 */
export function getRoleLabel(role: string): string {
  const roleMap: Record<string, string> = {
    // 2026-07-10 归位三部门:业务开发(sales) / 业务执行(merchandiser) / 生产(production)
    // 之前 i18n 把 sales 错标成「业务执行」、merchandiser 错标成「生产部QC」,与 UserRoleManager/组织架构相反,已改回
    'sales': '业务开发',       // 开发业务部:PO 前主导(客户开发/报价/PO确认);PO 后只读全程可见
    'sales_manager': '开发业务经理',
    'merchandiser': '业务执行',  // 业务执行部(原理单):PO 确认后接手,一路跟到出货
    'order_manager': '业务执行经理', // 业务执行部主管(高洁);key 仍是 order_manager,只改显示名
    'finance': '财务',
    'procurement': '采购',
    'procurement_manager': '采购经理',
    'production': '生产跟单',   // 生产部(工厂侧大货跟进 + QC 验货)
    'qc': '生产跟单',          // 质检并入生产部,与生产跟单同岗
    'quality': '生产跟单',     // 质检（旧值）
    'logistics': '物流/仓库',
    'production_manager': '生产部主管',
    'admin_assistant': '行政督办',
    'admin': '管理员',
  };
  
  return roleMap[role.toLowerCase()] || role;
}

