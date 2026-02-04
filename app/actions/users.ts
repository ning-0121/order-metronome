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
