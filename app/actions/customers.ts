'use server';

import { createClient } from '@/lib/supabase/server';

export interface Customer {
  id: string;
  customer_code: string | null;
  customer_name: string;
  company_name: string | null;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  country: string | null;
  city: string | null;
  customer_type: string | null;
  notes: string | null;
}

/**
 * 获取所有客户（按名称排序，排除已软删除）
 */
export async function getCustomers(): Promise<{ data: Customer[] | null; error: string | null }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: null, error: '请先登录' };

  const { data, error } = await (supabase.from('customers') as any)
    .select('id, customer_code, customer_name, company_name, contact_name, email, phone, country, city, customer_type, notes')
    .is('deleted_at', null)
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
    .select('id, customer_code, customer_name, company_name, contact_name, email, phone, country, city, customer_type, notes')
    .single();

  if (error) {
    if (error.code === '23505') {
      return { data: null, error: `客户"${trimmed}"已存在` };
    }
    return { data: null, error: error.message };
  }

  return { data, error: null };
}
