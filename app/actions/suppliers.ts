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
import { pickEditableSupplierFields, maskSupplierFinance } from '@/lib/procurement/purchaseOrder';
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
  const auth = await authRoles();
  if (!auth.userId) return { error: auth.error };
  const supabase = await createClient();
  const { data, error } = await (supabase.from('suppliers') as any)
    .select('*').neq('status', 'archived').order('name', { ascending: true });
  if (error) return { error: error.message };
  // 财务字段(银行/税号/账期)按角色剥离(审计 P0:此前对全员可读)
  const canFin = hasRoleInGroup(auth.roles, 'CAN_EDIT_SUPPLIER_FINANCE');
  return { data: maskSupplierFinance(data || [], canFin) };
}

export async function getSupplier(id: string): Promise<{ data?: any; error?: string }> {
  const auth = await authRoles();
  if (!auth.userId) return { error: auth.error };
  const supabase = await createClient();
  const { data, error } = await (supabase.from('suppliers') as any).select('*').eq('id', id).maybeSingle();
  if (error) return { error: error.message };
  if (!data) return { error: '供应商不存在' };
  const canFin = hasRoleInGroup(auth.roles, 'CAN_EDIT_SUPPLIER_FINANCE');
  return { data: maskSupplierFinance(data, canFin) };
}

/** 同名(忽略大小写/首尾空格)未归档供应商 → 返回该行;无重复 → null。 */
async function findDuplicateSupplier(supabase: any, name: string, excludeId?: string) {
  let q = (supabase.from('suppliers') as any)
    .select('id, name, supplier_code, contact_name, main_category')
    .ilike('name', name.trim())            // ilike 无通配符 = 忽略大小写的精确匹配
    .neq('status', 'archived');
  if (excludeId) q = q.neq('id', excludeId);
  const { data } = await q.limit(1);
  return (data && data[0]) || null;
}

/** 建供应商 —— 由能编辑业务字段的角色发起(业务/采购)；财务条款可后续 update 补。同名直接拒绝(防重复)。 */
export async function createSupplier(input: SupplierInput): Promise<{ id?: string; error?: string; duplicate?: any }> {
  const auth = await authRoles();
  if (!auth.userId) return { error: auth.error };
  const canBasic = hasRoleInGroup(auth.roles, 'CAN_EDIT_SUPPLIER_BASIC');
  const canFinance = hasRoleInGroup(auth.roles, 'CAN_EDIT_SUPPLIER_FINANCE');
  if (!canBasic) return { error: '仅业务/采购/管理员可新建供应商' };
  if (!input.name?.trim()) return { error: '供应商名称必填' };

  const supabase = await createClient();
  const dup = await findDuplicateSupplier(supabase, input.name);
  if (dup) return { error: `供应商「${dup.name}」已存在(${dup.contact_name || dup.main_category || '点列表可编辑'}),不能重复录入`, duplicate: dup };

  const fields = pickEditableSupplierFields(input as any, canBasic, canFinance);
  fields.name = input.name.trim();

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
  // 改名撞已有供应商 → 拒绝(防止靠改名制造重复)
  if (typeof fields.name === 'string' && fields.name.trim()) {
    const dup = await findDuplicateSupplier(supabase, fields.name, id);
    if (dup) return { error: `已有同名供应商「${dup.name}」,不能改成重复名称` };
  }
  const { error } = await (supabase.from('suppliers') as any).update(fields).eq('id', id);
  if (error) return { error: error.message };
  await pushSupplierToFinance(supabase, id);
  revalidatePath('/suppliers');
  return { success: true };
}

/**
 * 删供应商。有采购单引用 → 归档(不再出现在列表/下拉,历史采购单保留可查);
 * 无引用 → 硬删(供应商报价 material_supplier 级联删除)。
 */
export async function deleteSupplier(id: string): Promise<{ deleted?: boolean; archived?: boolean; error?: string }> {
  const auth = await authRoles();
  if (!auth.userId) return { error: auth.error };
  if (!hasRoleInGroup(auth.roles, 'CAN_EDIT_SUPPLIER_BASIC')) return { error: '仅业务/采购/管理员可删除供应商' };

  const supabase = await createClient();
  const { count: poCount } = await (supabase.from('purchase_orders') as any)
    .select('id', { count: 'exact', head: true }).eq('supplier_id', id);

  if ((poCount || 0) > 0) {
    const { error } = await (supabase.from('suppliers') as any)
      .update({ status: 'archived', updated_at: new Date().toISOString() }).eq('id', id);
    if (error) return { error: error.message };
    revalidatePath('/suppliers');
    return { archived: true };
  }

  const { data: deleted, error } = await (supabase.from('suppliers') as any)
    .delete().eq('id', id).select('id');
  if (error) return { error: '删除失败：' + error.message };
  if (!deleted || deleted.length === 0) {
    return { error: '删除未生效:数据库缺少 DELETE 权限,请先在 Supabase 执行 20260703 迁移 SQL(或先用归档)' };
  }
  revalidatePath('/suppliers');
  return { deleted: true };
}

/**
 * Excel 批量导入供应商。逐行:名称必填 → 查重(库里 + 本文件内) → 插入。
 * 重复不导入(报告里列出);财务字段仅财务/管理员的导入生效,其余角色自动忽略。
 */
export async function bulkImportSuppliers(rows: SupplierInput[]): Promise<{
  created?: number;
  updated?: number;   // 同名已存在 → 非破坏性补全"库里为空"的字段(联系人/电话/账期…)
  skipped?: Array<{ row: number; name: string; reason: string }>;
  failed?: Array<{ row: number; name: string; reason: string }>;
  error?: string;
}> {
  const auth = await authRoles();
  if (!auth.userId) return { error: auth.error };
  const canBasic = hasRoleInGroup(auth.roles, 'CAN_EDIT_SUPPLIER_BASIC');
  const canFinance = hasRoleInGroup(auth.roles, 'CAN_EDIT_SUPPLIER_FINANCE');
  if (!canBasic) return { error: '仅业务/采购/管理员可批量导入供应商' };
  if (!Array.isArray(rows) || rows.length === 0) return { error: 'Excel 里没有可导入的数据行' };
  if (rows.length > 500) return { error: `一次最多导入 500 行(本次 ${rows.length} 行),请拆分文件` };

  const supabase = await createClient();
  // 一次拉全部未归档供应商(含现有字段值),用于查重 + 非破坏性补全(小表,远快于逐行查库)
  const { data: existing } = await (supabase.from('suppliers') as any)
    .select('id, name, address, phone, contact_name, main_category, payment_method, bank_info, tax_id, net_days')
    .neq('status', 'archived');
  const existingByName = new Map<string, any>();
  for (const s of (existing || []) as any[]) existingByName.set(String(s.name).trim().toLowerCase(), s);
  const seen = new Set<string>(existingByName.keys());

  const str = (v: any) => { const s = String(v ?? '').trim(); return s || null; };
  const toNetDays = (v: any) => (v == null || String(v).trim() === '' || isNaN(Number(v)) ? null : Number(v));

  let created = 0;
  let updated = 0;
  const skipped: Array<{ row: number; name: string; reason: string }> = [];
  const failed: Array<{ row: number; name: string; reason: string }> = [];
  const financeSyncIds: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i] || {};
    const rowNo = i + 2;                              // Excel 行号(1=表头)
    const name = String(raw.name || '').trim();
    if (!name) { skipped.push({ row: rowNo, name: '(空)', reason: '供应商名称为空' }); continue; }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      // 非破坏性补全(2026-07-06):同名已存在 → 只补"库里为空、导入有值"的字段(不覆盖已有值)。
      // 解决"当初只导了名字"的历史供应商:再导一次带联系人/电话/账期的表即可批量补全,免逐个手改。
      const exist = existingByName.get(key);
      const candidate: SupplierInput = {
        address: str(raw.address) ?? undefined, phone: str(raw.phone) ?? undefined,
        contact_name: str(raw.contact_name) ?? undefined, main_category: str(raw.main_category) ?? undefined,
        payment_method: str(raw.payment_method) ?? undefined, bank_info: str(raw.bank_info) ?? undefined,
        tax_id: str(raw.tax_id) ?? undefined, net_days: toNetDays(raw.net_days),
      };
      const editable = pickEditableSupplierFields(candidate as any, canBasic, canFinance);
      const patch: Record<string, any> = {};
      for (const [k, v] of Object.entries(editable)) {
        if (v == null || v === '') continue;                            // 导入这列没值 → 不动
        const cur = (exist as any)?.[k];
        if (cur == null || String(cur).trim() === '') patch[k] = v;     // 仅当库里为空才补
      }
      if (exist && Object.keys(patch).length > 0) {
        patch.updated_at = new Date().toISOString();
        const { error } = await (supabase.from('suppliers') as any).update(patch).eq('id', exist.id);
        if (error) { failed.push({ row: rowNo, name, reason: error.message }); continue; }
        Object.assign(exist, patch);   // 同步内存,免同文件后续同名行重复补
        updated += 1;
        financeSyncIds.push(exist.id);
        continue;
      }
      skipped.push({ row: rowNo, name, reason: '已存在且无可补全信息,跳过' });
      continue;
    }

    // Excel 单元格全是字符串:数字列转 number,文本列 trim,空转 null
    const input: SupplierInput = {
      name,
      address: str(raw.address) ?? undefined, phone: str(raw.phone) ?? undefined,
      contact_name: str(raw.contact_name) ?? undefined, main_category: str(raw.main_category) ?? undefined,
      payment_method: str(raw.payment_method) ?? undefined, bank_info: str(raw.bank_info) ?? undefined,
      tax_id: str(raw.tax_id) ?? undefined,
      net_days: raw.net_days == null || String(raw.net_days).trim() === '' || isNaN(Number(raw.net_days))
        ? null : Number(raw.net_days),
    };
    const fields = pickEditableSupplierFields(input as any, canBasic, canFinance);
    fields.name = name;
    const { data, error } = await (supabase.from('suppliers') as any)
      .insert({ ...fields, created_by: auth.userId }).select('id').single();
    if (error) { failed.push({ row: rowNo, name, reason: error.message }); continue; }
    seen.add(key);                                    // 文件内重复也会被拦住
    created += 1;
    financeSyncIds.push((data as any).id);
  }

  // 财务同步:批量结束后统一推(逐个 best-effort,失败不影响导入结果)
  await Promise.allSettled(financeSyncIds.map((id) => pushSupplierToFinance(supabase, id)));

  revalidatePath('/suppliers');
  return { created, updated, skipped, failed };
}
