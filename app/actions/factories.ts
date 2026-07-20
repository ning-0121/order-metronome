'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { isAdminRole } from '@/lib/domain/roles';

/**
 * 更换订单工厂(2026-07-09 用户:生产主管要能改工厂)。仅 admin / 生产主管。
 * 传 factoryId 从工厂库带出名字;factoryId 为空则清空工厂。
 */
export async function updateOrderFactory(
  orderId: string,
  factoryId: string | null,
): Promise<{ ok?: boolean; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: profile } = await supabase.from('profiles').select('role, roles').eq('user_id', user.id).single();
  const userRoles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  if (!isAdminRole(userRoles) && !userRoles.includes('production_manager')) {
    return { error: '只有管理员或生产主管可以更换工厂' };
  }

  let factory_name: string | null = null;
  if (factoryId) {
    const { data: f } = await (supabase.from('factories') as any)
      .select('factory_name').eq('id', factoryId).is('deleted_at', null).maybeSingle();
    if (!f) return { error: '工厂不存在' };
    factory_name = (f as any).factory_name;
  }

  const { error } = await (supabase.from('orders') as any)
    .update({ factory_id: factoryId, factory_name }).eq('id', orderId);
  if (error) return { error: error.message };

  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}

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
  extra?: {
    product_categories?: string[]; worker_count?: number; monthly_capacity?: number;
    contact_name?: string | null; phone?: string | null; city?: string | null; address?: string | null;
    cooperation_status?: string | null; notes?: string | null;
    quality_grades?: string[]; weave_types?: string[]; can_package?: boolean | null; order_capabilities?: string[];
  }
): Promise<{ data: Factory | null; error: string | null }> {
  const trimmed = factoryName?.trim();
  if (!trimmed) return { data: null, error: '工厂名称不能为空' };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: null, error: '请先登录' };

  const { data: profile } = await supabase.from('profiles').select('role, roles').eq('user_id', user.id).single();
  const userRoles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  if (!isAdminRole(userRoles) && !userRoles.some(r => ['production_manager', 'procurement', 'procurement_manager'].includes(r))) {
    return { data: null, error: '只有管理员/生产主管/采购可以新建工厂' };
  }

  const insertPayload: Record<string, any> = { factory_name: trimmed };
  if (extra?.product_categories?.length) insertPayload.product_categories = extra.product_categories;
  if (extra?.worker_count) insertPayload.worker_count = extra.worker_count;
  if (extra?.monthly_capacity) insertPayload.monthly_capacity = extra.monthly_capacity;
  if (extra?.contact_name) insertPayload.contact_name = extra.contact_name.trim();
  if (extra?.phone) insertPayload.phone = extra.phone.trim();
  if (extra?.city) insertPayload.city = extra.city.trim();
  if (extra?.address) insertPayload.address = extra.address.trim();
  if (extra?.cooperation_status) insertPayload.cooperation_status = extra.cooperation_status;
  if (extra?.notes) insertPayload.notes = extra.notes.trim();
  if (extra?.quality_grades?.length) insertPayload.quality_grades = extra.quality_grades;
  if (extra?.weave_types?.length) insertPayload.weave_types = extra.weave_types;
  if (typeof extra?.can_package === 'boolean') insertPayload.can_package = extra.can_package;
  if (extra?.order_capabilities?.length) insertPayload.order_capabilities = extra.order_capabilities;

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
