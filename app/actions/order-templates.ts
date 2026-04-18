'use server';

import { createClient } from '@/lib/supabase/server';
import { getCurrentUserRole } from '@/lib/utils/user-role';

export interface OrderTemplate {
  id: string;
  name: string;
  description: string | null;
  template_type: 'production' | 'sample';
  incoterm: string | null;
  delivery_type: string | null;
  order_type: string | null;
  sample_phase: string | null;
  sample_confirm_days_override: number | null;
  shipping_sample_required: boolean;
  risk_flags: string[];
  default_notes: string | null;
  is_active: boolean;
  sort_order: number;
  usage_count: number;
  created_at: string;
  updated_at: string;
}

/** 获取所有启用的模板（业务新建订单时调用） */
export async function getActiveOrderTemplates(): Promise<{
  data: OrderTemplate[] | null;
  error?: string;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: null, error: '未登录' };

  const { data, error } = await (supabase.from('order_templates') as any)
    .select('*')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });

  if (error) return { data: null, error: error.message };
  return { data: data || [] };
}

/** 获取所有模板（管理员后台） */
export async function getAllOrderTemplates(): Promise<{
  data: OrderTemplate[] | null;
  error?: string;
}> {
  const supabase = await createClient();
  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { data: null, error: '无权限' };

  const { data, error } = await (supabase.from('order_templates') as any)
    .select('*')
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });

  if (error) return { data: null, error: error.message };
  return { data: data || [] };
}

/** 创建模板（仅管理员） */
export async function createOrderTemplate(
  input: Partial<OrderTemplate>
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const supabase = await createClient();
  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { ok: false, error: '无权限' };

  const { data: { user } } = await supabase.auth.getUser();

  const { data, error } = await (supabase.from('order_templates') as any)
    .insert({
      name: input.name,
      description: input.description || null,
      template_type: input.template_type || 'production',
      incoterm: input.incoterm || null,
      delivery_type: input.delivery_type || null,
      order_type: input.order_type || null,
      sample_phase: input.sample_phase || null,
      sample_confirm_days_override: input.sample_confirm_days_override || null,
      shipping_sample_required: input.shipping_sample_required || false,
      risk_flags: input.risk_flags || [],
      default_notes: input.default_notes || null,
      is_active: input.is_active !== false,
      sort_order: input.sort_order || 0,
      created_by: user?.id || null,
    })
    .select('id')
    .single();

  if (error) return { ok: false, error: error.message };
  return { ok: true, id: data?.id };
}

/** 更新模板（仅管理员） */
export async function updateOrderTemplate(
  id: string,
  input: Partial<OrderTemplate>
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { ok: false, error: '无权限' };

  const { data: { user } } = await supabase.auth.getUser();

  const updates: any = { updated_at: new Date().toISOString(), updated_by: user?.id };
  if (input.name !== undefined) updates.name = input.name;
  if (input.description !== undefined) updates.description = input.description;
  if (input.template_type !== undefined) updates.template_type = input.template_type;
  if (input.incoterm !== undefined) updates.incoterm = input.incoterm;
  if (input.delivery_type !== undefined) updates.delivery_type = input.delivery_type;
  if (input.order_type !== undefined) updates.order_type = input.order_type;
  if (input.sample_phase !== undefined) updates.sample_phase = input.sample_phase;
  if (input.sample_confirm_days_override !== undefined) updates.sample_confirm_days_override = input.sample_confirm_days_override;
  if (input.shipping_sample_required !== undefined) updates.shipping_sample_required = input.shipping_sample_required;
  if (input.risk_flags !== undefined) updates.risk_flags = input.risk_flags;
  if (input.default_notes !== undefined) updates.default_notes = input.default_notes;
  if (input.is_active !== undefined) updates.is_active = input.is_active;
  if (input.sort_order !== undefined) updates.sort_order = input.sort_order;

  const { error } = await (supabase.from('order_templates') as any)
    .update(updates)
    .eq('id', id);

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** 删除模板（软删除 — 仅禁用） */
export async function deleteOrderTemplate(
  id: string
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { ok: false, error: '无权限' };

  const { error } = await (supabase.from('order_templates') as any)
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** 记录模板使用次数（新建订单时套用模板时调用） */
export async function incrementTemplateUsage(id: string): Promise<void> {
  try {
    const supabase = await createClient();
    const { data: tpl } = await (supabase.from('order_templates') as any)
      .select('usage_count')
      .eq('id', id)
      .single();
    if (tpl) {
      await (supabase.from('order_templates') as any)
        .update({ usage_count: (tpl.usage_count || 0) + 1 })
        .eq('id', id);
    }
  } catch {
    // 静默失败：usage_count 是统计字段，失败不影响主流程
  }
}
