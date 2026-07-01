'use server';

/**
 * 供应商主数据（Supplier Master · P1）
 *
 * 字段级分工：业务填 name/address/phone/contact_name/main_category；
 * 财务填 payment_method/net_days/bank_info/tax_id。action 层强制(pickEditableSupplierFields)。
 * factories 不再当供应商;新采购单供应商归宿 = suppliers。
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { hasRoleInGroup } from '@/lib/domain/roles';
import { pickEditableSupplierFields } from '@/lib/procurement/purchaseOrder';
import { syncSupplierToFinance } from '@/lib/integration/finance-sync';

/** 供应商 upsert 后同步财务（P2b，未配置即跳过，绝不阻塞主链）。 */
async function pushSupplierToFinance(supabase: any, id: string) {
  try {
    const { data: full } = await (supabase.from('suppliers') as any).select('*').eq('id', id).maybeSingle();
    if (full) await syncSupplierToFinance(full);
  } catch { /* 财务同步失败不影响供应商主流程 */ }
}

async function authRoles(): Promise<{ userId?: string; roles: string[]; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { roles: [], error: '请先登录' };
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles').eq('user_id', user.id).single();
  const roles: string[] =
    (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  return { userId: user.id, roles };
}

export interface SupplierInput {
  name?: string; address?: string; phone?: string; contact_name?: string; main_category?: string;
  payment_method?: string; net_days?: number | null; bank_info?: string; tax_id?: string;
}

export async function listSuppliers(): Promise<{ data?: any[]; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data, error } = await (supabase.from('suppliers') as any)
    .select('*').neq('status', 'archived').order('name', { ascending: true });
  if (error) return { error: error.message };
  return { data: data || [] };
}

export async function getSupplier(id: string): Promise<{ data?: any; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data, error } = await (supabase.from('suppliers') as any).select('*').eq('id', id).maybeSingle();
  if (error) return { error: error.message };
  if (!data) return { error: '供应商不存在' };
  return { data };
}

/** 建供应商 —— 由能编辑业务字段的角色发起(业务/采购)；财务条款可后续 update 补。 */
export async function createSupplier(input: SupplierInput): Promise<{ id?: string; error?: string }> {
  const auth = await authRoles();
  if (!auth.userId) return { error: auth.error };
  const canBasic = hasRoleInGroup(auth.roles, 'CAN_EDIT_SUPPLIER_BASIC');
  const canFinance = hasRoleInGroup(auth.roles, 'CAN_EDIT_SUPPLIER_FINANCE');
  if (!canBasic) return { error: '仅业务/采购/管理员可新建供应商' };
  if (!input.name?.trim()) return { error: '供应商名称必填' };

  const fields = pickEditableSupplierFields(input as any, canBasic, canFinance);
  fields.name = input.name.trim();

  const supabase = await createClient();
  const { data, error } = await (supabase.from('suppliers') as any)
    .insert({ ...fields, created_by: auth.userId }).select('id').single();
  if (error) return { error: '创建失败：' + error.message };
  await pushSupplierToFinance(supabase, (data as any).id);
  revalidatePath('/suppliers');
  return { id: (data as any).id };
}

/** 改供应商 —— 只写该角色可编辑字段组(业务字段 vs 财务字段)。 */
export async function updateSupplier(id: string, input: SupplierInput): Promise<{ error?: string; success?: boolean }> {
  const auth = await authRoles();
  if (!auth.userId) return { error: auth.error };
  const canBasic = hasRoleInGroup(auth.roles, 'CAN_EDIT_SUPPLIER_BASIC');
  const canFinance = hasRoleInGroup(auth.roles, 'CAN_EDIT_SUPPLIER_FINANCE');
  if (!canBasic && !canFinance) return { error: '无权编辑供应商' };

  const fields = pickEditableSupplierFields(input as any, canBasic, canFinance);
  if (Object.keys(fields).length === 0) return { error: '没有你有权修改的字段' };
  fields.updated_at = new Date().toISOString();

  const supabase = await createClient();
  const { error } = await (supabase.from('suppliers') as any).update(fields).eq('id', id);
  if (error) return { error: error.message };
  await pushSupplierToFinance(supabase, id);
  revalidatePath('/suppliers');
  return { success: true };
}
