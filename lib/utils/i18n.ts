/**
 * Internationalization utilities for UI labels
 * Only for display text, NOT database values
 */

/**
 * Map role to Chinese label
 */
export function getRoleLabel(role: string): string {
  const roleMap: Record<string, string> = {
    'sales': '业务开发',       // 2026版:开发业务部，PO前主导，PO后只读全程可见
    'sales_manager': '开发业务经理',
    'merchandiser': '理单/订单执行',  // 订单管理部
    'order_manager': '订单管理经理',
    'finance': '财务',
    'procurement': '采购',
    'procurement_manager': '采购经理',
    'production': '生产跟单',   // 生产部:工厂侧大货跟进
    'qc': '生产跟单',          // 质检并入生产跟单
    'quality': '生产跟单',     // 质检（旧值）并入生产跟单
    'logistics': '物流/仓库',
    'production_manager': '生产主管',
    'admin_assistant': '行政督办',
    'admin': '管理员',
  };
  
  return roleMap[role.toLowerCase()] || role;
}

/**
 * Map status to Chinese label (for display only)
 */
export function getStatusLabel(status: string): string {
  const statusMap: Record<string, string> = {
    'in_progress': '进行中',
    'pending': '待处理',
    'blocked': '已阻塞',
    'overdue': '已超期',
    'done': '已完成',
    'critical': '关键节点',
    // Chinese statuses (already in Chinese)
    '进行中': '进行中',
    '待处理': '待处理',
    '已阻塞': '已阻塞',
    '已超期': '已超期',
    '已完成': '已完成',
    '关键节点': '关键节点',
  };
  
  return statusMap[status.toLowerCase()] || status;
}
