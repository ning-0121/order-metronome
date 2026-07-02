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
import { convertUnit, type UomRow } from '@/lib/services/material-catalog';
// 编码规则(类别前缀 + 流水)统一在 material-autocode:BOM 各入库口共用同一套码
import { genMaterialCode as genCode } from '@/lib/services/material-autocode';

const CREATE_ROLES = ['sales', 'merchandiser', 'sales_manager', 'order_manager', 'procurement', 'procurement_manager', 'admin'];
const MANAGE_ROLES = ['merchandiser', 'procurement', 'procurement_manager', 'admin'];

async function rolesOf(supabase: any, userId: string): Promise<string[]> {
  const { data: p } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', userId).single();
  return (p as any)?.roles?.length > 0 ? (p as any).roles : [(p as any)?.role].filter(Boolean);
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

// ════════════════════════════════════════════════════════════════════════
// SC-P1 物料 OS 完整:多供应商图 · 单位换算 · 替代物料 · 库存策略
// 写权限沿用 MANAGE_ROLES(理单/采购/采购经理/admin);读=登录即可。纯加法,不动既有列。
// ════════════════════════════════════════════════════════════════════════

const numOrNull = (v: any) => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));
/** 写权限门:返回 { supabase, userId } 或 { error }。 */
async function requireManage(): Promise<{ supabase: any; userId?: string; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { supabase, error: '请先登录' };
  const roles = await rolesOf(supabase, user.id);
  if (!roles.some(r => MANAGE_ROLES.includes(r))) return { supabase, error: '仅理单/采购/管理员可维护' };
  return { supabase, userId: user.id };
}

// ── 多供应商图 ──
export async function listMaterialSuppliers(materialMasterId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data, error } = await (supabase.from('material_supplier') as any)
    .select('id, supplier_id, unit_price, currency, lead_days, moq, purchase_unit, is_preferred, last_quoted_at, note, suppliers(name)')
    .eq('material_master_id', materialMasterId)
    .order('is_preferred', { ascending: false });
  if (error) return { error: friendlyError(error) };
  return { data: (data || []).map((r: any) => ({ ...r, supplier_name: r.suppliers?.name || null })) };
}

export async function upsertMaterialSupplier(input: {
  id?: string; materialMasterId: string; supplierId: string;
  unit_price?: any; currency?: string; lead_days?: any; moq?: any; purchase_unit?: string;
  is_preferred?: boolean; last_quoted_at?: string | null; note?: string;
}) {
  const { supabase, userId, error } = await requireManage();
  if (error) return { error };
  if (!input.materialMasterId || !input.supplierId) return { error: '缺物料或供应商' };
  const row: any = {
    material_master_id: input.materialMasterId, supplier_id: input.supplierId,
    unit_price: numOrNull(input.unit_price), currency: input.currency || 'CNY',
    lead_days: numOrNull(input.lead_days), moq: numOrNull(input.moq),
    purchase_unit: input.purchase_unit || null, is_preferred: !!input.is_preferred,
    last_quoted_at: input.last_quoted_at || null, note: input.note || null,
    created_by: userId, updated_at: new Date().toISOString(),
  };
  // 首选唯一:置为首选时,清掉同物料其他首选
  if (row.is_preferred) {
    await (supabase.from('material_supplier') as any)
      .update({ is_preferred: false }).eq('material_master_id', input.materialMasterId);
  }
  const { error: upErr } = await (supabase.from('material_supplier') as any)
    .upsert(row, { onConflict: 'material_master_id,supplier_id' });
  if (upErr) return { error: friendlyError(upErr) };
  revalidatePath('/material-master');
  return { ok: true };
}

export async function deleteMaterialSupplier(id: string) {
  const { supabase, error } = await requireManage();
  if (error) return { error };
  const { error: dErr } = await (supabase.from('material_supplier') as any).delete().eq('id', id);
  if (dErr) return { error: friendlyError(dErr) };
  revalidatePath('/material-master');
  return { ok: true };
}

// ── 单位换算 ──
export async function listMaterialUom(materialMasterId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data, error } = await (supabase.from('material_uom') as any)
    .select('id, from_unit, to_unit, factor, note').eq('material_master_id', materialMasterId).order('from_unit');
  if (error) return { error: friendlyError(error) };
  return { data: data || [] };
}

export async function upsertMaterialUom(input: {
  materialMasterId: string; from_unit: string; to_unit: string; factor: any; note?: string;
}) {
  const { supabase, error } = await requireManage();
  if (error) return { error };
  const factor = numOrNull(input.factor);
  if (!input.from_unit?.trim() || !input.to_unit?.trim()) return { error: '单位不能为空' };
  if (!(factor && factor > 0)) return { error: '换算系数必须 > 0' };
  if (input.from_unit.trim() === input.to_unit.trim()) return { error: '源/目标单位不能相同' };
  const { error: upErr } = await (supabase.from('material_uom') as any).upsert({
    material_master_id: input.materialMasterId, from_unit: input.from_unit.trim(),
    to_unit: input.to_unit.trim(), factor, note: input.note || null,
  }, { onConflict: 'material_master_id,from_unit,to_unit' });
  if (upErr) return { error: friendlyError(upErr) };
  revalidatePath('/material-master');
  return { ok: true };
}

export async function deleteMaterialUom(id: string) {
  const { supabase, error } = await requireManage();
  if (error) return { error };
  const { error: dErr } = await (supabase.from('material_uom') as any).delete().eq('id', id);
  if (dErr) return { error: friendlyError(dErr) };
  revalidatePath('/material-master');
  return { ok: true };
}

/** 单位换算(读 material_uom → 纯 convertUnit)。无路径返回 null + 提示。 */
export async function convertMaterialUnit(materialMasterId: string, qty: number, from: string, to: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data } = await (supabase.from('material_uom') as any)
    .select('from_unit, to_unit, factor').eq('material_master_id', materialMasterId);
  const result = convertUnit(qty, from, to, (data || []) as UomRow[]);
  return { data: result, hasPath: result != null };
}

// ── 替代物料图(双 FK 同表 → JS join,避开脆弱嵌套) ──
export async function listMaterialAlternatives(materialMasterId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data, error } = await (supabase.from('material_alternative') as any)
    .select('id, alt_material_master_id, relation, ratio, note').eq('material_master_id', materialMasterId);
  if (error) return { error: friendlyError(error) };
  const altIds = Array.from(new Set((data || []).map((r: any) => r.alt_material_master_id).filter(Boolean)));
  const nameMap = new Map<string, any>();
  if (altIds.length) {
    const { data: ms } = await (supabase.from('material_master') as any)
      .select('id, material_name, material_code').in('id', altIds);
    for (const m of (ms || [])) nameMap.set(m.id, m);
  }
  return {
    data: (data || []).map((r: any) => ({
      ...r,
      alt_material_name: nameMap.get(r.alt_material_master_id)?.material_name || null,
      alt_material_code: nameMap.get(r.alt_material_master_id)?.material_code || null,
    })),
  };
}

export async function upsertMaterialAlternative(input: {
  materialMasterId: string; altMaterialMasterId: string; relation?: string; ratio?: any; note?: string;
}) {
  const { supabase, userId, error } = await requireManage();
  if (error) return { error };
  if (!input.altMaterialMasterId) return { error: '请选择替代物料' };
  if (input.altMaterialMasterId === input.materialMasterId) return { error: '不能替代自己' };
  const rel = ['equivalent', 'substitute', 'upgrade'].includes(input.relation || '') ? input.relation : 'substitute';
  const { error: upErr } = await (supabase.from('material_alternative') as any).upsert({
    material_master_id: input.materialMasterId, alt_material_master_id: input.altMaterialMasterId,
    relation: rel, ratio: numOrNull(input.ratio) ?? 1, note: input.note || null, created_by: userId,
  }, { onConflict: 'material_master_id,alt_material_master_id' });
  if (upErr) return { error: friendlyError(upErr) };
  revalidatePath('/material-master');
  return { ok: true };
}

export async function deleteMaterialAlternative(id: string) {
  const { supabase, error } = await requireManage();
  if (error) return { error };
  const { error: dErr } = await (supabase.from('material_alternative') as any).delete().eq('id', id);
  if (dErr) return { error: friendlyError(dErr) };
  revalidatePath('/material-master');
  return { ok: true };
}

// ── 库存策略(物料级安全库存/再订货点/最高库存;P3 补货引擎读) ──
export async function setMaterialStockPolicy(id: string, patch: {
  safety_stock_qty?: any; reorder_point?: any; max_stock?: any;
}) {
  const { supabase, error } = await requireManage();
  if (error) return { error };
  const upd: any = { updated_at: new Date().toISOString() };
  if ('safety_stock_qty' in patch) upd.safety_stock_qty = numOrNull(patch.safety_stock_qty);
  if ('reorder_point' in patch) upd.reorder_point = numOrNull(patch.reorder_point);
  if ('max_stock' in patch) upd.max_stock = numOrNull(patch.max_stock);
  const { error: uErr } = await (supabase.from('material_master') as any).update(upd).eq('id', id);
  if (uErr) return { error: friendlyError(uErr) };
  revalidatePath('/material-master');
  return { ok: true };
}

/** 详情面板一次性拉:库存策略当前值(供 UI 预填)。 */
export async function getMaterialStockPolicy(id: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data } = await (supabase.from('material_master') as any)
    .select('safety_stock_qty, reorder_point, max_stock').eq('id', id).maybeSingle();
  return { data: data || {} };
}
