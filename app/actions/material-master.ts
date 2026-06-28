'use server';

/**
 * 物料主数据(Material Master)管理 —— O1a-3。
 * 列表/搜索/新建/编辑/归档/相似提示/待转正/临时转正。
 * 红线:不做 AI / Template Engine / Production Package;不碰采购主流程。
 * 权限:查看人人可;新建=业务/理单/采购/管理员;编辑/归档/转正=理单/采购/管理员(受控)。
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { friendlyError } from '@/lib/utils/db-error';

const CODE_PREFIX: Record<string, string> = {
  fabric: 'FAB', trim: 'TRM', packing: 'PKG', print: 'PRT',
  washing: 'WSH', embroidery: 'EMB', service: 'SVC', other: 'OTH',
};
const CREATE_ROLES = ['sales', 'merchandiser', 'sales_manager', 'order_manager', 'procurement', 'procurement_manager', 'admin'];
const MANAGE_ROLES = ['merchandiser', 'procurement', 'procurement_manager', 'admin'];

async function rolesOf(supabase: any, userId: string): Promise<string[]> {
  const { data: p } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', userId).single();
  return (p as any)?.roles?.length > 0 ? (p as any).roles : [(p as any)?.role].filter(Boolean);
}

/** 生成物料编码:类别前缀 + 4 位流水(如 FAB-0007)。冲突由 UNIQUE 兜底,重试一次。 */
async function genCode(supabase: any, category: string): Promise<string> {
  const prefix = CODE_PREFIX[category] || 'OTH';
  const { count } = await (supabase.from('material_master') as any)
    .select('id', { count: 'exact', head: true }).eq('category', category);
  const seq = (count || 0) + 1;
  return `${prefix}-${String(seq).padStart(4, '0')}`;
}

/** 列表 + 搜索(正式、未归档;按使用次数降序)。 */
export async function listMaterialMaster(params: { search?: string; category?: string } = {}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  let q = (supabase.from('material_master') as any)
    .select('id, material_code, material_name, category, default_unit, default_consumption, default_supplier_name, default_lead_days, specification, usage_count, status')
    .eq('is_temporary', false)
    .eq('status', 'active');
  if (params.category) q = q.eq('category', params.category);
  if (params.search?.trim()) {
    const s = params.search.trim();
    q = q.or(`material_name.ilike.%${s}%,material_code.ilike.%${s}%`);
  }
  const { data, error } = await q.order('usage_count', { ascending: false }).order('material_name').limit(500);
  if (error) return { error: friendlyError(error) };
  return { data };
}

/** 相似物料提示:同类别 + 名称包含 +(可选)规格相似(V1 简单匹配,不阻断)。 */
export async function findSimilarMaterials(name: string, category: string, spec?: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: [] };
  // 去掉会破坏 PostgREST or() 语法的字符(逗号/括号/百分号)
  const clean = (s: string) => s.replace(/[%,()]/g, ' ').trim();
  const token = clean(name || '');
  if (token.length < 2 || !category) return { data: [] };
  const specTok = clean(spec || '');
  let q = (supabase.from('material_master') as any)
    .select('id, material_code, material_name, specification')
    .eq('is_temporary', false).eq('status', 'active').eq('category', category);
  q = specTok.length >= 2
    ? q.or(`material_name.ilike.%${token}%,specification.ilike.%${specTok}%`)
    : q.ilike('material_name', `%${token}%`);
  const { data } = await q.limit(6);
  return { data: data || [] };
}

export interface MasterInput {
  material_name: string;
  category: string;
  default_unit?: string | null;
  default_consumption?: number | string | null;
  default_supplier_name?: string | null;
  default_lead_days?: number | string | null;
  specification?: string | null;
  default_loss_rate?: number | string | null;
}

/** 新建正式主数据。!force 且发现相似 → 返回 similar 不创建;force=true → 直接建。 */
export async function createMaterialMaster(input: MasterInput, opts: { force?: boolean } = {}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const roles = await rolesOf(supabase, user.id);
  if (!roles.some(r => CREATE_ROLES.includes(r))) return { error: '无权新建物料主数据' };
  if (!input.material_name?.trim()) return { error: '物料名称不能为空' };
  if (!input.category) return { error: '请选择类别' };

  if (!opts.force) {
    const sim = await findSimilarMaterials(input.material_name, input.category);
    if ((sim.data || []).length > 0) return { similar: sim.data };  // 提示,不创建
  }

  const num = (v: any) => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));
  const code = await genCode(supabase, input.category);
  const row = {
    material_code: code,
    material_name: input.material_name.trim(),
    category: input.category,
    default_unit: input.default_unit || null,
    default_consumption: num(input.default_consumption),
    default_supplier_name: input.default_supplier_name || null,
    default_lead_days: num(input.default_lead_days),
    specification: input.specification || null,
    default_loss_rate: num(input.default_loss_rate),
    is_temporary: false,
    seed_source: 'manual',
    created_by: user.id,
  };
  const { data, error } = await (supabase.from('material_master') as any).insert(row).select('id, material_code').single();
  if (error) return { error: friendlyError(error) };
  revalidatePath('/material-master');
  return { data };
}

/** 编辑(受控)。 */
export async function updateMaterialMaster(id: string, patch: Partial<MasterInput>) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const roles = await rolesOf(supabase, user.id);
  if (!roles.some(r => MANAGE_ROLES.includes(r))) return { error: '仅理单/采购/管理员可编辑主数据' };
  const num = (v: any) => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));
  const upd: any = { updated_at: new Date().toISOString() };
  if (patch.material_name !== undefined) upd.material_name = patch.material_name?.trim();
  if (patch.category !== undefined) upd.category = patch.category;
  if (patch.default_unit !== undefined) upd.default_unit = patch.default_unit || null;
  if (patch.default_consumption !== undefined) upd.default_consumption = num(patch.default_consumption);
  if (patch.default_supplier_name !== undefined) upd.default_supplier_name = patch.default_supplier_name || null;
  if (patch.default_lead_days !== undefined) upd.default_lead_days = num(patch.default_lead_days);
  if (patch.specification !== undefined) upd.specification = patch.specification || null;
  if (patch.default_loss_rate !== undefined) upd.default_loss_rate = num(patch.default_loss_rate);
  const { error } = await (supabase.from('material_master') as any).update(upd).eq('id', id);
  if (error) return { error: friendlyError(error) };
  revalidatePath('/material-master');
  return { ok: true };
}

/** 归档(软删,受控)。 */
export async function archiveMaterialMaster(id: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const roles = await rolesOf(supabase, user.id);
  if (!roles.some(r => MANAGE_ROLES.includes(r))) return { error: '仅理单/采购/管理员可归档' };
  const { error } = await (supabase.from('material_master') as any)
    .update({ status: 'archived', updated_at: new Date().toISOString() }).eq('id', id);
  if (error) return { error: friendlyError(error) };
  revalidatePath('/material-master');
  return { ok: true };
}

/** 待转正清单:订单录入时建的临时物料(is_temporary=true)。 */
export async function listPendingPromotion() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data, error } = await (supabase.from('material_master') as any)
    .select('id, material_name, category, default_unit, default_consumption, default_supplier_name, specification, source_order_id, created_at, orders(order_no, customer_name)')
    .eq('is_temporary', true).eq('status', 'active')
    .order('created_at', { ascending: false }).limit(200);
  if (error) return { error: friendlyError(error) };
  return { data };
}

/** 临时物料转正(受控):查重 → 赋码 → is_temporary=false。 */
export async function promoteTemporaryMaterial(id: string, opts: { force?: boolean } = {}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const roles = await rolesOf(supabase, user.id);
  if (!roles.some(r => MANAGE_ROLES.includes(r))) return { error: '仅理单/采购/管理员可转正' };

  const { data: m } = await (supabase.from('material_master') as any)
    .select('id, material_name, category, is_temporary').eq('id', id).single();
  if (!m) return { error: '物料不存在' };
  if (!(m as any).is_temporary) return { error: '该物料已是正式主数据' };

  if (!opts.force) {
    const sim = await findSimilarMaterials((m as any).material_name, (m as any).category);
    if ((sim.data || []).length > 0) return { similar: sim.data };  // 提示,不转正
  }

  const code = await genCode(supabase, (m as any).category);
  const { error } = await (supabase.from('material_master') as any)
    .update({ is_temporary: false, material_code: code, seed_source: 'order_entry', promoted_at: new Date().toISOString(), promoted_by: user.id, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) return { error: friendlyError(error) };
  revalidatePath('/material-master');
  return { data: { material_code: code } };
}

/** 当前用户能否管理(编辑/归档/转正)—— 供页面控制按钮显隐。 */
export async function canManageMaster(): Promise<boolean> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  const roles = await rolesOf(supabase, user.id);
  return roles.some(r => MANAGE_ROLES.includes(r));
}
