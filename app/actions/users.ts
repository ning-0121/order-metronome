'use server';

import { createClient } from '@/lib/supabase/server';
import { getCurrentUserRole } from '@/lib/utils/user-role';

export interface User {
  user_id: string;
  email: string;
  full_name: string | null;
  role: string | null;
  roles: string[];
}

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
      roles: p.roles || [],
    })),
    error: null,
  };
}

/**
 * 更新用户角色（仅管理员可操作）
 */
export async function updateUserRoles(
  targetUserId: string,
  newRoles: string[],
  newName?: string
): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const { isAdmin } = await getCurrentUserRole(supabase);

  if (!isAdmin) {
    return { error: '无权限：仅管理员可修改用户角色' };
  }

  const updateData: any = {
    roles: newRoles,
    role: newRoles[0] || 'sales', // 兼容旧 role 字段
  };

  if (newName !== undefined) {
    updateData.name = newName;
  }

  const { error } = await (supabase.from('profiles') as any)
    .update(updateData)
    .eq('user_id', targetUserId);

  if (error) {
    return { error: error.message };
  }

  return { error: null };
}
