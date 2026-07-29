'use server';

/** 报关主数据维护(2026-07-28 报关4件套)。管理/财务/业务可写;service-role 落库(不吃 RLS)。 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { hasRoleInGroup } from '@/lib/domain/roles';
import { revalidatePath } from 'next/cache';

async function gate(): Promise<string | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return '请先登录';
  const { data: prof } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (prof as any)?.roles?.length ? (prof as any).roles : [(prof as any)?.role].filter(Boolean);
  const ok = roles.includes('admin') || hasRoleInGroup(roles, 'CAN_SEE_FINANCIALS') || roles.some((r) => ['merchandiser', 'order_manager'].includes(r));
  return ok ? null : '仅管理/财务/业务可维护报关主数据';
}

export async function upsertHsCatalog(row: { id?: string; match_key: string; hs_code?: string; customs_name?: string; customs_spec?: string; unit?: string }): Promise<{ ok: boolean; error?: string }> {
  const err = await gate(); if (err) return { ok: false, error: err };
  if (!row.match_key?.trim()) return { ok: false, error: '匹配键必填(款号前缀或品名关键词)' };
  const svc = createServiceRoleClient();
  const payload = { match_key: row.match_key.trim(), hs_code: row.hs_code?.trim() || null, customs_name: row.customs_name?.trim() || null, customs_spec: row.customs_spec?.trim() || null, unit: row.unit?.trim() || '件', updated_at: new Date().toISOString() };
  const { error } = row.id
    ? await (svc.from('customs_hs_catalog') as any).update(payload).eq('id', row.id)
    : await (svc.from('customs_hs_catalog') as any).insert(payload);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/admin/customs-master');
  return { ok: true };
}

export async function deleteHsCatalog(id: string): Promise<{ ok: boolean; error?: string }> {
  const err = await gate(); if (err) return { ok: false, error: err };
  const svc = createServiceRoleClient();
  const { error } = await (svc.from('customs_hs_catalog') as any).delete().eq('id', id);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/admin/customs-master');
  return { ok: true };
}

export async function saveCustomsDefaults(data: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
  const err = await gate(); if (err) return { ok: false, error: err };
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) if (v?.trim()) clean[k] = v.trim();
  const svc = createServiceRoleClient();
  const { error } = await (svc.from('customs_defaults') as any).upsert({ id: 1, data: clean, updated_at: new Date().toISOString() });
  if (error) return { ok: false, error: error.message };
  revalidatePath('/admin/customs-master');
  return { ok: true };
}

export async function saveCustomerCustoms(customerId: string, patch: { consignee_name_en?: string; customs_address?: string; tax_no?: string }): Promise<{ ok: boolean; error?: string }> {
  const err = await gate(); if (err) return { ok: false, error: err };
  const svc = createServiceRoleClient();
  const { error } = await (svc.from('customers') as any).update({
    consignee_name_en: patch.consignee_name_en?.trim() || null,
    customs_address: patch.customs_address?.trim() || null,
    tax_no: patch.tax_no?.trim() || null,
  }).eq('id', customerId);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/admin/customs-master');
  return { ok: true };
}
