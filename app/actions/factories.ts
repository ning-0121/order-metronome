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
  product_categories: string[] | null;
  worker_count: number | null;
  monthly_capacity: number | null;
  capacity_unit: string | null;
}

// PRODUCT_CATEGORIES 已移至 lib/constants/factory.ts（客户端可安全导入）

/**
 * 获取所有工厂（按名称排序，排除已软删除）
 */
export async function getFactories(): Promise<{ data: Factory[] | null; error: string | null }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: null, error: '请先登录' };

  const { data, error } = await (supabase.from('factories') as any)
    .select('id, factory_code, factory_name, contact_name, phone, country, city, address, category, cooperation_status, notes, product_categories, worker_count, monthly_capacity, capacity_unit')
    .is('deleted_at', null)
    .order('factory_name', { ascending: true });

  if (error) return { data: null, error: error.message };
  return { data: data || [], error: null };
}

/**
 * 新建工厂（最少字段：factory_name 必填）
 */
export async function createFactory(
  factoryName: string,
  extra?: { product_categories?: string[]; worker_count?: number; monthly_capacity?: number }
): Promise<{ data: Factory | null; error: string | null }> {
  const trimmed = factoryName?.trim();
  if (!trimmed) return { data: null, error: '工厂名称不能为空' };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: null, error: '请先登录' };

  const insertPayload: Record<string, any> = { factory_name: trimmed };
  if (extra?.product_categories?.length) insertPayload.product_categories = extra.product_categories;
  if (extra?.worker_count) insertPayload.worker_count = extra.worker_count;
  if (extra?.monthly_capacity) insertPayload.monthly_capacity = extra.monthly_capacity;

  const { data, error } = await (supabase.from('factories') as any)
    .insert(insertPayload)
    .select('id, factory_code, factory_name, contact_name, phone, country, city, address, category, cooperation_status, notes, product_categories, worker_count, monthly_capacity, capacity_unit')
    .single();

  if (error) {
    if (error.code === '23505') {
      return { data: null, error: `工厂"${trimmed}"已存在` };
    }
    return { data: null, error: error.message };
  }

  return { data, error: null };
}
