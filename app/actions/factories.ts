'use server';

import { createClient } from '@/lib/supabase/server';

export interface Factory {
  id: string;
  factory_code: string | null;
  factory_name: string;
  contact_name: string | null;
  phone: string | null;
  country: string | null;
  city: string | null;
  address: string | null;
  category: string | null;
  cooperation_status: string | null;
  notes: string | null;
}

/**
 * 获取所有工厂（按名称排序，排除已软删除）
 */
export async function getFactories(): Promise<{ data: Factory[] | null; error: string | null }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: null, error: '请先登录' };

  const { data, error } = await (supabase.from('factories') as any)
    .select('id, factory_code, factory_name, contact_name, phone, country, city, address, category, cooperation_status, notes')
    .is('deleted_at', null)
    .order('factory_name', { ascending: true });

  if (error) return { data: null, error: error.message };
  return { data: data || [], error: null };
}

/**
 * 新建工厂（最少字段：factory_name 必填）
 */
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
    .select('id, factory_code, factory_name, contact_name, phone, country, city, address, category, cooperation_status, notes')
    .single();

  if (error) {
    if (error.code === '23505') {
      return { data: null, error: `工厂"${trimmed}"已存在` };
    }
    return { data: null, error: error.message };
  }

  return { data, error: null };
}
