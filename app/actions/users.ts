'use server';

import { createClient } from '@/lib/supabase/server';

export interface User {
  user_id: string;
  email: string;
  /** Display name: profiles.name or email (avoid full_name) */
  full_name: string | null;
  role: string | null;
}

/**
 * Get all users from profiles table.
 * Uses profiles.name or email; avoids full_name. If profiles missing, returns empty (caller may use auth users).
 */
export async function getAllUsers(): Promise<{ data: User[] | null; error: string | null }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { data: null, error: 'Unauthorized' };
  }

  const { data: profiles, error } = await (supabase.from('profiles') as any)
    .select('user_id, email, name, role')
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
    })),
    error: null,
  };
}

interface UpdateUserRoleInput {
  userId: string;
  role?: string | null;
  department?: string | null;
  isActive?: boolean;
}

/**
 * Admin-only: update target user's role/department/status.
 */
export async function updateUserRoleByAdmin(
  input: UpdateUserRoleInput
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: '未登录' };
  }

  const { data: me, error: meErr } = await (supabase.from('profiles') as any)
    .select('role')
    .eq('user_id', user.id)
    .single();

  if (meErr || !me || me.role !== 'admin') {
    return { error: '无权限' };
  }

  const patch: Record<string, unknown> = {
    role: input.role ?? null,
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
