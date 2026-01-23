/**
 * Internationalization utilities for UI labels
 * Only for display text, NOT database values
 */

/**
 * Map role to Chinese label
 */
export function getRoleLabel(role: string): string {
  const roleMap: Record<string, string> = {
    'sales': '业务',
    'finance': '财务',
    'procurement': '采购',
    'production': '生产',
    'qc': '质检',
    'logistics': '物流',
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
