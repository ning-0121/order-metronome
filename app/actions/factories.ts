'use server';

import { createClient } from '@/lib/supabase/server';

export interface Factory {
  id: string;
  factory_name: string;
}

export async function getFactories(): Promise<{ data: Factory[] | null; error: string | null }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: null, error: '请先登录' };

  const { data, error } = await (supabase.from('factories') as any)
    .select('id, factory_name')
    .order('factory_name', { ascending: true });

  if (error) return { data: null, error: error.message };
  return { data: data || [], error: null };
}

export async function createFactory(
  factoryName: string
): Promise<{ data: Factory | null; error: string | null }> {
  const trimmed = factoryName?.trim();
  if (!trimmed) return { data: null, error: '工厂名称不能为空' };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: null, error: '请先登录' };

  const { data, error } = await (supabase.from('factories') as any)
    .insert({ factory_name: trimmed })
    .select('id, factory_name')
    .single();

  if (error) {
    if (error.code === '23505') {
      return { data: null, error: `工厂"${trimmed}"已存在` };
    }
    return { data: null, error: error.message };
  }

  return { data, error: null };
}
