/**
 * V1 Minimal Role Permissions
 * 
 * Role determination:
 * - Admin allowlist: alex@qimoclothing.com, su@qimoclothing.com => role=admin
 * - Others: default role=sales (V1)
 * 
 * TODO: Later add user_roles table for proper role management
 */

export type UserRole = 'admin' | 'sales' | 'merchandiser' | 'finance' | 'procurement' | 'production' | 'qc' | 'logistics';

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
 *
 * 角色口径（2026-06-01 统一）：
 *  1. 主口径 = profiles 表的 roles（与 getUserRoles 一致），全站统一
 *  2. 邮箱白名单（ADMIN_ALLOWLIST）降级为「保底 admin」——
 *     即使 profiles 记录缺失/查表失败，alex/su 永远是 admin，不会失权
 *  3. profiles 无角色且非白名单 → 退回邮箱推断角色（保持旧行为，不制造回归）
 *
 * 修复了此前「只认邮箱白名单」导致的全站问题：任何在 profiles 里
 * 配置了 admin/finance/logistics 等角色、但邮箱不在白名单的用户，
 * 之前一律被错判为 isAdmin=false / role='sales'，在订单详情页、仓库页
 * 等处功能受限或被错误重定向（如延期审批按钮不显示）。
 */
export async function getCurrentUserRole(supabase: any): Promise<{ role: UserRole; isAdmin: boolean; userId?: string | null; roles?: string[] }> {
  const { data: { user } } = await supabase.auth.getUser();

  if (!user || !user.email) {
    return { role: 'sales', isAdmin: false, userId: null, roles: [] };
  }

  // 邮箱白名单：保底 admin（profiles 缺失也不失权）
  const emailRole = getUserRoleFromEmail(user.email);
  const emailIsAdmin = emailRole === 'admin';

  // 主口径：查 profiles 表角色
  let profileRoles: string[] = [];
  try {
    const { data: profile } = await supabase
      .from('profiles')
      .select('role, roles')
      .eq('user_id', user.id)
      .single();
    if (profile) {
      profileRoles = (profile as any).roles?.length > 0
        ? (profile as any).roles
        : [(profile as any).role].filter(Boolean);
    }
  } catch {
    // 查表失败 → 静默退回邮箱口径，永不抛错（不阻塞鉴权主链路）
  }

  const isAdmin = emailIsAdmin || profileRoles.includes('admin');

  // 主角色：admin 优先 → profiles 首个角色 → 邮箱推断角色（保底）
  let role: UserRole;
  if (isAdmin) {
    role = 'admin';
  } else if (profileRoles.length > 0) {
    role = profileRoles[0] as UserRole;
  } else {
    role = emailRole;
  }

  // 复审性能:一并返回 userId + roles(本函数已查过 auth+profiles),调用方无需再各查一次
  return { role, isAdmin, userId: user.id, roles: profileRoles };
}

/**
 * 获取用户的多角色列表（从 profiles 表）
 * 统一提取，避免各 action 重复编写同样的查询逻辑
 */
export async function getUserRoles(supabase: any, userId: string): Promise<string[]> {
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, roles')
    .eq('user_id', userId)
    .single();
  if (!profile) return [];
  const roles: string[] = profile.roles?.length > 0 ? profile.roles : [profile.role].filter(Boolean);
  return roles;
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
