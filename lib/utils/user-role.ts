/**
 * V2 Multi-Role Permission System
 *
 * 一个用户可以拥有多个角色（如 Helen = 理单 + 采购）
 *
 * 数据来源：profiles.roles text[]
 * 兼容：profiles.role 旧字段仍保留，getCurrentUserRole 会合并两者
 */

export type UserRole = 'admin' | 'ceo' | 'sales' | 'finance' | 'procurement' | 'production' | 'qc' | 'logistics';

const ADMIN_ALLOWLIST = [
  'alex@qimoclothing.com',
  'su@qimoclothing.com',
];

/**
 * Determine user role from email (legacy V1, 兜底用)
 */
export function getUserRoleFromEmail(email: string | null | undefined): UserRole {
  if (!email) return 'sales';
  if (ADMIN_ALLOWLIST.includes(email.toLowerCase().trim())) return 'admin';
  return 'sales';
}

/**
 * Check if user is admin (legacy)
 */
export function isAdmin(email: string | null | undefined): boolean {
  return getUserRoleFromEmail(email) === 'admin';
}

/**
 * Get current user roles (server-side)
 * Returns { roles, role (primary/compat), isAdmin }
 */
export async function getCurrentUserRole(supabase: any): Promise<{
  role: UserRole;
  roles: string[];
  isAdmin: boolean;
}> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !user.email) {
    return { role: 'sales', roles: ['sales'], isAdmin: false };
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, roles, is_active')
    .eq('user_id', user.id)
    .maybeSingle();

  // 账号已停用
  if (profile && profile.is_active === false) {
    return { role: 'sales', roles: ['sales'], isAdmin: false };
  }

  // 构建 roles 数组：优先用 profiles.roles，兜底用 profiles.role
  let roles: string[] = [];
  if (profile?.roles && Array.isArray(profile.roles) && profile.roles.length > 0) {
    roles = profile.roles;
  } else if (profile?.role) {
    roles = [profile.role];
  }

  // 兜底：admin allowlist
  if (roles.length === 0) {
    const fallback = getUserRoleFromEmail(user.email);
    roles = [fallback];
  }

  const hasAdmin = roles.includes('admin') || roles.includes('ceo');
  // primary role = 第一个角色（兼容旧代码）
  const primaryRole = (roles[0] || 'sales') as UserRole;

  return { role: primaryRole, roles, isAdmin: hasAdmin };
}

// ══ 多角色权限辅助函数 ══════════════════════════════════

/** 检查用户是否拥有某个角色 */
export function hasRole(roles: string[], target: string): boolean {
  if (!roles || roles.length === 0) return false;
  return roles.some(r => r.toLowerCase() === target.toLowerCase());
}

/** 检查用户是否拥有任一角色 */
export function hasAnyRole(roles: string[], targets: string[]): boolean {
  if (!roles || roles.length === 0) return false;
  return targets.some(t => hasRole(roles, t));
}

/**
 * Check if user can modify milestone
 * V2: admin OR any of user's roles matches milestone owner_role
 */
export function canModifyMilestone(
  currentRole: UserRole,
  isAdmin: boolean,
  milestoneOwnerRole: string,
  roles?: string[]
): boolean {
  if (isAdmin) return true;

  // V2: 多角色匹配
  if (roles && roles.length > 0) {
    const ownerNorm = milestoneOwnerRole.toLowerCase().trim();
    return roles.some(r => {
      const rNorm = r.toLowerCase().trim();
      if (rNorm === ownerNorm) return true;
      // qc/quality 互通
      if (ownerNorm === 'qc' && (rNorm === 'qc' || rNorm === 'quality')) return true;
      if (ownerNorm === 'quality' && (rNorm === 'qc' || rNorm === 'quality')) return true;
      return false;
    });
  }

  // V1 fallback
  return currentRole.toLowerCase().trim() === milestoneOwnerRole.toLowerCase().trim();
}

/** 可以新建/编辑订单的角色 */
export function canCreateOrder(role?: string | null, roles?: string[]): boolean {
  const allowed = ['admin', 'ceo', 'sales'];
  if (roles && roles.length > 0) return hasAnyRole(roles, allowed);
  return allowed.includes(role || '');
}

/** 可以查看全部订单 */
export function canViewAllOrders(role?: string | null, roles?: string[]): boolean {
  const allowed = ['admin', 'ceo', 'finance', 'procurement', 'production', 'qc', 'logistics', 'quality'];
  if (roles && roles.length > 0) return hasAnyRole(roles, allowed);
  return allowed.includes(role || '');
}

/** 可以处理指定角色的里程碑节点 */
export function canHandleMilestone(userRole?: string | null, milestoneOwnerRole?: string | null, isAdmin = false, roles?: string[]): boolean {
  if (isAdmin) return true;
  if (!milestoneOwnerRole) return false;

  // V2 多角色
  if (roles && roles.length > 0) {
    const ownerNorm = milestoneOwnerRole.toLowerCase();
    return roles.some(r => {
      const rNorm = r.toLowerCase();
      if (rNorm === ownerNorm) return true;
      if (ownerNorm === 'qc' && (rNorm === 'qc' || rNorm === 'quality')) return true;
      return false;
    });
  }

  // V1 fallback
  if (!userRole) return false;
  if (milestoneOwnerRole === 'qc' && (userRole === 'qc' || userRole === 'quality')) return true;
  return userRole.toLowerCase() === milestoneOwnerRole.toLowerCase();
}

/** 可以访问管理后台 */
export function canAccessAdmin(role?: string | null, roles?: string[]): boolean {
  const allowed = ['admin', 'ceo'];
  if (roles && roles.length > 0) return hasAnyRole(roles, allowed);
  return allowed.includes(role || '');
}

/** 可以访问仓库工作台 */
export function canAccessWarehouse(role?: string | null, roles?: string[]): boolean {
  const allowed = ['admin', 'logistics'];
  if (roles && roles.length > 0) return hasAnyRole(roles, allowed);
  return allowed.includes(role || '');
}

/** 可以查看财务数据 */
export function canViewFinancials(role?: string | null, roles?: string[]): boolean {
  const allowed = ['admin', 'ceo', 'finance'];
  if (roles && roles.length > 0) return hasAnyRole(roles, allowed);
  return allowed.includes(role || '');
}

/** 出货三方签核权限 */
export function getShipmentSignRole(role?: string | null, roles?: string[]): 'sales' | 'warehouse' | 'finance' | null {
  const check = (r: string) => {
    if (r === 'sales') return 'sales' as const;
    if (r === 'logistics') return 'warehouse' as const;
    if (r === 'finance') return 'finance' as const;
    return null;
  };

  if (roles && roles.length > 0) {
    for (const r of roles) {
      const result = check(r);
      if (result) return result;
    }
    return null;
  }

  return check(role || '');
}

/** 角色中文标签 */
export const ROLE_LABEL: Record<string, string> = {
  admin: '管理员', ceo: 'CEO', sales: '理单', finance: '财务',
  procurement: '采购', production: '生产', qc: '质检',
  logistics: '物流/仓库', quality: '品控',
};

/** 将 roles 数组格式化为显示文本，如 "理单 / 采购" */
export function formatRolesLabel(roles: string[] | null | undefined): string {
  if (!roles || roles.length === 0) return '未授权';
  return roles.map(r => ROLE_LABEL[r] || r).join(' / ');
}

/** 角色对应的工作台描述 */
export const ROLE_DASHBOARD_DESC: Record<string, string> = {
  admin:       '全局视图：逾期节点、风险订单、系统运行状态',
  ceo:         '经营总览：在途订单、出货进度、异常趋势',
  sales:       '我的订单：待处理执行节点、延期申请、船样确认',
  finance:     '财务看板：待审核节点、收款跟进、成本核算',
  procurement: '采购看板：待确认原辅料、采购订单进度',
  production:  '生产看板：开裁计划、产前会安排、进度跟踪',
  qc:          'QC看板：待检验订单、中查 / 尾查计划',
  logistics:   '仓库看板：待发料、待装箱、出货签核',
  quality:     'QC看板：待检验订单、检验报告',
};
