import { getUserRoles } from '@/lib/utils/user-role';
import { hasRoleInGroup, isAdminRole, type RoleGroupKey } from '@/lib/domain/roles';

/**
 * 服务端角色组门禁(2026-07-10 审计 #5:收口一批 login-only 写)。
 * 命中 group → 返回 null(放行);否则返回错误文案。调用方须已 getUser() 拿到 userId。
 *   const err = await requireRoleGroup(supabase, user.id, 'EXECUTION', '仅生产/QC…');
 *   if (err) return { error: err };
 * admin 始终放行:admin 是系统超级角色(canSeeAll/override 各组皆含 admin),
 * 且这些门禁文案本身都写「…/管理员可…」。EXECUTION 等功能角色组不列 admin,
 * 若不在此兜底,admin 会被自己门禁挡在门外(生产任务单/QC 保存失败)。
 */
export async function requireRoleGroup(
  supabase: any, userId: string, group: RoleGroupKey, msg?: string,
): Promise<string | null> {
  const roles = await getUserRoles(supabase, userId);
  if (isAdminRole(roles)) return null;
  return hasRoleInGroup(roles, group) ? null : (msg || '无权限');
}
