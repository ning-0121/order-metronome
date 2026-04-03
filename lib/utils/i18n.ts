/**
 * Internationalization utilities for UI labels
 * Only for display text, NOT database values
 */

/**
 * Map role to Chinese label
 */
export function getRoleLabel(role: string): string {
  const roleMap: Record<string, string> = {
    'sales': '业务/理单',
    'merchandiser': '跟单',
    'finance': '财务',
    'procurement': '采购',
    'production': '跟单',     // 生产已合并到跟单
    'qc': '跟单',             // 质检已合并到跟单
    'quality': '跟单',        // 质检（旧值）已合并到跟单
    'logistics': '物流/仓库',
    'production_manager': '生产主管',
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
