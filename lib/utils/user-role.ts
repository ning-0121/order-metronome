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
 */
export async function getCurrentUserRole(supabase: any): Promise<{ role: UserRole; isAdmin: boolean }> {
  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user || !user.email) {
    return { role: 'sales', isAdmin: false };
  }
  
  const role = getUserRoleFromEmail(user.email);
  return {
    role,
    isAdmin: role === 'admin',
  };
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
