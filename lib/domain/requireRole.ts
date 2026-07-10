import { getUserRoles } from '@/lib/utils/user-role';
import { hasRoleInGroup, type RoleGroupKey } from '@/lib/domain/roles';

/**
 * 服务端角色组门禁(2026-07-10 审计 #5:收口一批 login-only 写)。
 * 命中 group → 返回 null(放行);否则返回错误文案。调用方须已 getUser() 拿到 userId。
 *   const err = await requireRoleGroup(supabase, user.id, 'EXECUTION', '仅生产/QC…');
 *   if (err) return { error: err };
 */
export async function requireRoleGroup(
  supabase: any, userId: string, group: RoleGroupKey, msg?: string,
): Promise<string | null> {
  const roles = await getUserRoles(supabase, userId);
  return hasRoleInGroup(roles, group) ? null : (msg || '无权限');
}
