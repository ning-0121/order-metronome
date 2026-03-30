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

  if (password.length < 8) {
    return { error: '密码至少需要8位' };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        name,
        full_name: name,
      },
      emailRedirectTo: `${process.env.NEXT_PUBLIC_SITE_URL || 'https://order.qimoactivewear.com'}/auth/callback`,
    },
  });

  if (error) {
    if (error.message.includes('already registered') || error.message.includes('already been registered')) {
      return { error: '该邮箱已注册，请直接登录' };
    }
    if (error.message.includes('Password')) {
      return { error: '密码格式不符合要求，请使用至少8位密码' };
    }
    return { error: '注册失败：' + error.message };
  }

  // 注册成功后写入 profiles（触发器兜底，这里显式处理 name）
  if (data.user) {
    await supabase.from('profiles').upsert({
      user_id: data.user.id,
      email: data.user.email,
      name: name,
      full_name: name,
      role: null,
      is_active: true,
    }, { onConflict: 'user_id' });
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
    if (error.message.includes('Invalid login credentials')) {
      return { error: '邮箱或密码错误，请重试' };
    }
    if (error.message.includes('Email not confirmed')) {
      return { error: '邮箱尚未验证，请查收验证邮件后再登录' };
    }
    return { error: '登录失败：' + error.message };
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
  if (!user) { return null; }
  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('user_id', user.id)
    .single();
  return profile;
}
