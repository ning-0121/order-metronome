'use server';

import { createClient } from '@/lib/supabase/server';

export interface Customer {
  id: string;
  customer_name: string;
}

/**
 * 获取所有客户（按名称排序）
 */
export async function getCustomers(): Promise<{ data: Customer[] | null; error: string | null }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: null, error: '请先登录' };

  const { data, error } = await (supabase.from('customers') as any)
    .select('id, customer_name')
    .order('customer_name', { ascending: true });

  if (error) return { data: null, error: error.message };
  return { data: data || [], error: null };
}

/**
 * 新建客户（最少字段：customer_name 必填）
 */
export async function createCustomer(
  customerName: string
): Promise<{ data: Customer | null; error: string | null }> {
  const trimmed = customerName?.trim();
  if (!trimmed) return { data: null, error: '客户名称不能为空' };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: null, error: '请先登录' };

  const { data, error } = await (supabase.from('customers') as any)
    .insert({ customer_name: trimmed })
    .select('id, customer_name')
    .single();

  if (error) {
    if (error.code === '23505') {
      return { data: null, error: `客户"${trimmed}"已存在` };
    }
    return { data: null, error: error.message };
  }

  return { data, error: null };
}
