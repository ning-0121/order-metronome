/**
 * V1 Minimal Role Permissions
 * 
 * Role determination:
 * - Admin allowlist: alex@qimoclothing.com, su@qimoclothing.com => role=admin
 * - Others: default role=sales (V1)
 * 
 * TODO: Later add user_roles table for proper role management
 */

export type UserRole = 'admin' | 'sales' | 'finance' | 'procurement' | 'production' | 'qc' | 'logistics';

const ADMIN_ALLOWLIST = [
  'alex@qimoclothing.com',
  'su@qimoclothing.com',
];

/**
 * Determine user role from email
 * V1: Simple allowlist for admin, default to sales
 */
export function getUserRoleFromEmail(email: string | null | undefined): UserRole {
  if (!email) {
    return 'sales';
  }
  
  const normalizedEmail = email.toLowerCase().trim();
  
  if (ADMIN_ALLOWLIST.includes(normalizedEmail)) {
    return 'admin';
  }
  
  // V1: Default to sales for all other users
  // TODO: Later query user_roles table for actual role
  return 'sales';
}

/**
 * Check if user is admin
 */
export function isAdmin(email: string | null | undefined): boolean {
  return getUserRoleFromEmail(email) === 'admin';
}

/**
 * Get current user role (server-side)
 * Returns { role, isAdmin }
 */
export async function getCurrentUserRole(supabase: any): Promise<{ role: UserRole; isAdmin: boolean }> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !user.email) {
    return { role: 'sales', isAdmin: false };
  }

  // 优先从 profiles.role 读取（由 Admin 在用户管理页授权）
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, is_active')
    .eq('user_id', user.id)
    .maybeSingle();

  // 账号已停用
  if (profile && profile.is_active === false) {
    return { role: 'sales', isAdmin: false };
  }

  // 有明确授权角色则使用
  if (profile?.role) {
    const role = profile.role as UserRole;
    return { role, isAdmin: role === 'admin' || role === 'ceo' };
  }

  // 兜底：admin allowlist（确保 alex 和 su 无论如何都能访问）
  const role = getUserRoleFromEmail(user.email);
  return { role, isAdmin: role === 'admin' };
}

/**
 * Check if user can modify milestone
 * V1: admin OR milestone.owner_role matches currentRole
 */
export function canModifyMilestone(
  currentRole: UserRole,
  isAdmin: boolean,
  milestoneOwnerRole: string
): boolean {
  if (isAdmin) {
    return true;
  }
  
  // Normalize milestone owner role for comparison
  const normalizedOwnerRole = milestoneOwnerRole.toLowerCase().trim();
  const normalizedCurrentRole = currentRole.toLowerCase().trim();
  
  return normalizedOwnerRole === normalizedCurrentRole;
}


// ══ 角色权限辅助函数 ══════════════════════════════════════════

/** 可以新建/编辑订单的角色 */
export function canCreateOrder(role?: string | null): boolean {
  return ['admin', 'ceo', 'sales'].includes(role || '');
}

/** 可以查看全部订单（不只自己的） */
export function canViewAllOrders(role?: string | null): boolean {
  return ['admin', 'ceo', 'finance', 'procurement', 'production', 'qc', 'logistics', 'quality'].includes(role || '');
}

/** 可以处理指定角色的里程碑节点 */
export function canHandleMilestone(userRole?: string | null, milestoneOwnerRole?: string | null, isAdmin = false): boolean {
  if (isAdmin) return true;
  if (!userRole || !milestoneOwnerRole) return false;
  // qc 和 quality 都能处理 qc 节点
  if (milestoneOwnerRole === 'qc' && (userRole === 'qc' || userRole === 'quality')) return true;
  return userRole.toLowerCase() === milestoneOwnerRole.toLowerCase();
}

/** 可以访问管理后台 */
export function canAccessAdmin(role?: string | null): boolean {
  return ['admin', 'ceo'].includes(role || '');
}

/** 可以访问仓库工作台 */
export function canAccessWarehouse(role?: string | null): boolean {
  return ['admin', 'logistics'].includes(role || '');
}

/** 可以查看财务数据（成本复盘） */
export function canViewFinancials(role?: string | null): boolean {
  return ['admin', 'ceo', 'finance'].includes(role || '');
}

/** 出货三方签核权限 */
export function getShipmentSignRole(role?: string | null): 'sales' | 'warehouse' | 'finance' | null {
  if (role === 'sales') return 'sales';
  if (role === 'logistics') return 'warehouse';
  if (role === 'finance') return 'finance';
  return null;
}

/** 角色中文标签 */
export const ROLE_LABEL: Record<string, string> = {
  admin: '管理员', ceo: 'CEO', sales: '业务', finance: '财务',
  procurement: '采购', production: '生产', qc: '质检',
  logistics: '物流/仓库', quality: '品控',
};

/** 角色对应的工作台描述 */
export const ROLE_DASHBOARD_DESC: Record<string, string> = {
  admin:       '全局视图：所有超期节点、风险订单、系统状态',
  ceo:         '经营总览：在途订单、出货进度、异常趋势',
  sales:       '我的订单：待处理节点、延期申请、船样确认',
  finance:     '财务看板：待审核节点、收款跟进、成本复盘',
  procurement: '采购看板：待确认原辅料、采购订单进度',
  production:  '生产看板：开裁计划、产前会安排、进度跟踪',
  qc:          'QC看板：待检验订单、中查/尾查计划',
  logistics:   '仓库看板：待发料、待装箱、待签核出货',
  quality:     'QC看板：待检验订单、检验报告',
};
