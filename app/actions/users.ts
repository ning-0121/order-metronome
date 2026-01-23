'use server';

import { createClient } from '@/lib/supabase/server';

export interface User {
  user_id: string;
  email: string;
  full_name: string | null;
  role: string | null;
}

/**
 * Get all users from profiles table
 * V1: Simple list of existing users (no full user management)
 */
export async function getAllUsers(): Promise<{ data: User[] | null; error: string | null }> {
  const supabase = await createClient();
  
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { data: null, error: 'Unauthorized' };
  }
  
  // Get all users from profiles
  const { data: profiles, error } = await (supabase
    .from('profiles') as any)
    .select('user_id, email, full_name, role')
    .order('email', { ascending: true });
  
  if (error) {
    return { data: null, error: error.message };
  }
  
  return {
    data: (profiles || []).map((p: any) => ({
      user_id: p.user_id,
      email: p.email || '',
      full_name: p.full_name || null,
      role: p.role || null,
    })),
    error: null,
  };
}
