'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { validateEmail } from '@/lib/utils/auth';

export async function signUp(email: string, password: string, name: string) {
  const validation = validateEmail(email);
  if (!validation.valid) {
    return { error: validation.error };
  }
  
  const supabase = await createClient();
  
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        name,
      },
      emailRedirectTo: `${process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'}/auth/callback`,
    },
  });
  
  if (error) {
    return { error: error.message };
  }
  
  return { data };
}

export async function signIn(email: string, password: string) {
  const validation = validateEmail(email);
  if (!validation.valid) {
    return { error: validation.error };
  }
  
  const supabase = await createClient();
  
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  
  if (error) {
    return { error: error.message };
  }
  
  revalidatePath('/', 'layout');
  return { data };
}

export async function signOut() {
  'use server';
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath('/', 'layout');
  redirect('/login');
}

export async function getCurrentUser() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

export async function getCurrentProfile() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) {
    return null;
  }
  
  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('user_id', user.id)
    .single();
  
  return profile;
}
