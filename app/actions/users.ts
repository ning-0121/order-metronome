'use server';

import { createClient } from '@/lib/supabase/server';

export interface User {
  user_id: string;
  email: string;
  full_name: string | null;
  role: string | null;
  roles: string[];
}

/**
 * Get all users from profiles table (V2: includes roles array).
 */
export async function getAllUsers(): Promise<{ data: User[] | null; error: string | null }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { data: null, error: 'Unauthorized' };
  }

  const { data: profiles, error } = await (supabase.from('profiles') as any)
    .select('user_id, email, name, role, roles')
    .order('email', { ascending: true });

  if (error) {
    return { data: null, error: error.message };
  }

  return {
    data: (profiles || []).map((p: any) => ({
      user_id: p.user_id,
      email: p.email || '',
      full_name: p.name ?? p.email ?? null,
      role: p.role || null,
      roles: Array.isArray(p.roles) && p.roles.length > 0 ? p.roles : (p.role ? [p.role] : []),
    })),
    error: null,
  };
}

interface UpdateUserRoleInput {
  userId: string;
  /** 旧字段，兼容 */
  role?: string | null;
  /** V2: 多角色数组 */
  roles?: string[];
  department?: string | null;
  isActive?: boolean;
}

/**
 * Admin-only: update target user's roles/department/status (V2: multi-role).
 */
export async function updateUserRoleByAdmin(
  input: UpdateUserRoleInput
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return { error: '未登录' };
  }

  const { data: me, error: meErr } = await (supabase.from('profiles') as any)
    .select('role, roles')
    .eq('user_id', user.id)
    .single();

  const meRoles: string[] = me?.roles?.length > 0 ? me.roles : [me?.role].filter(Boolean);
  if (meErr || !me || !meRoles.includes('admin')) {
    return { error: '无权限' };
  }

  // V2: roles 数组优先，同时写入 role（兼容旧逻辑，取 roles[0]）
  const roles = input.roles && input.roles.length > 0 ? input.roles : (input.role ? [input.role] : []);
  const primaryRole = roles[0] || null;

  const patch: Record<string, unknown> = {
    role: primaryRole,
    roles: roles,
    department: input.department ?? null,
    last_role_changed_at: new Date().toISOString(),
  };

  if (typeof input.isActive === 'boolean') {
    patch.is_active = input.isActive;
  }

  const { error } = await (supabase.from('profiles') as any)
    .update(patch)
    .eq('user_id', input.userId);

  if (error) {
    return { error: error.message };
  }

  return {};
}
