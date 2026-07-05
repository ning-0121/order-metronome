'use server';

/**
 * 物料主数据(Material Master)管理 —— O1a-3。
 * 列表/搜索/新建/编辑/归档/相似提示/待转正/临时转正。
 * 红线:不做 AI / Template Engine / Production Package;不碰采购主流程。
 * 权限:查看人人可;新建=业务/理单/采购/管理员;编辑/归档/转正=理单/采购/管理员(受控)。
 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
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
    .select('id, material_code, material_name, category, default_unit, default_consumption, default_supplier_name, default_lead_days, specification, reference_price, usage_count, status, created_by, created_at')
    .eq('is_temporary', false)
    .eq('status', 'active');
  if (params.category) q = q.eq('category', params.category);
  if (params.search?.trim()) {
    const s = params.search.trim();
    q = q.or(`material_name.ilike.%${s}%,material_code.ilike.%${s}%`);
  }
  const { data, error } = await q.order('usage_count', { ascending: false }).order('material_name').limit(500);
  if (error) return { error: friendlyError(error) };
  // 录入留痕:created_by → 姓名(一次查全,失败不阻断列表)
  try {
    const uids = [...new Set((data || []).map((r: any) => r.created_by).filter(Boolean))];
    if (uids.length > 0) {
      const { data: profs } = await (supabase.from('profiles') as any).select('user_id, name').in('user_id', uids);
      const nameMap = new Map<string, string>((profs || []).map((p: any) => [p.user_id, p.name]));
      for (const r of (data || [])) (r as any).created_by_name = r.created_by ? (nameMap.get(r.created_by) || null) : null;
    }
  } catch { /* 姓名解析失败不影响列表 */ }

  // 当前库存(2026-07-03 绑定深化):库存 key=consolidationKey,master 分支=`m:<id>¦c:色¦u:单位`。
  // 一个物料主数据可能对应多颜色 key → 按 master_id 前缀聚合各色在库之和。失败不阻断列表。
  try {
    const { data: txns } = await (supabase.from('inventory_transactions') as any).select('material_key, qty');
    const stockByMaster = new Map<string, number>();
    for (const t of (txns || [])) {
      const m = String(t.material_key || '').match(/^m:([^¦]+)¦/);
      if (m) stockByMaster.set(m[1], (stockByMaster.get(m[1]) || 0) + (Number(t.qty) || 0));
    }
    for (const r of (data || [])) {
      const v = stockByMaster.get((r as any).id);
      (r as any).stock_on_hand = v == null ? null : Math.round(v * 1000) / 1000;
    }
  } catch { /* 库存聚合失败不影响列表 */ }

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
  reference_price?: number | string | null;   // 参考价·不含税净价
}

/**
 * 完全 同名+同类别+同规格(忽略大小写/首尾空格)的正式物料 → 返回该行;无 → null。
 * 2026-07-03 变体模式:同名不同规格 = 合法(如「仿锦直贡呢拉毛」260g/270g/275g 三行),
 * 各自独立编码/价格/库存 —— 克重不同就是不同的可采购实物,不算重复。
 */
async function findExactDuplicateMaterial(supabase: any, name: string, category: string, spec?: string | null, excludeId?: string) {
  let q = (supabase.from('material_master') as any)
    .select('id, material_code, material_name, category, specification')
    .ilike('material_name', name.trim())   // ilike 无通配符 = 忽略大小写的精确匹配
    .eq('category', category)
    .eq('status', 'active').eq('is_temporary', false);
  if (excludeId) q = q.neq('id', excludeId);
  const { data } = await q.limit(20);
  const norm = (s: any) => String(s ?? '').trim().toLowerCase();
  return (data || []).find((r: any) => norm(r.specification) === norm(spec)) || null;
}

/**
 * 新建正式主数据。
 * 完全同名同类别 → 直接拒绝(force 也不放行,2026-07-03 防重复);
 * !force 且发现相似(模糊) → 返回 similar 提示不创建;force=true → 建。
 */
export async function createMaterialMaster(input: MasterInput, opts: { force?: boolean } = {}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const roles = await rolesOf(supabase, user.id);
  if (!roles.some(r => CREATE_ROLES.includes(r))) return { error: '无权新建物料主数据' };
  if (!input.material_name?.trim()) return { error: '物料名称不能为空' };
  if (!input.category) return { error: '请选择类别' };

  const dup = await findExactDuplicateMaterial(supabase, input.material_name, input.category, input.specification as any);
  if (dup) {
    return { error: `物料「${dup.material_name}」(${dup.material_code || '无编码'}${dup.specification ? ' · ' + dup.specification : ''})已存在,不能重复创建 — 同名布料请用不同「规格」(克重/门幅)区分变体`, duplicate: dup };
  }

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
    reference_price: num(input.reference_price),
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
  // 改名/改类别/改规格撞已有物料 → 拒绝(防止靠编辑制造重复;同名不同规格=合法变体)
  if (patch.material_name !== undefined || patch.category !== undefined || patch.specification !== undefined) {
    const { data: cur } = await (supabase.from('material_master') as any)
      .select('material_name, category, specification').eq('id', id).maybeSingle();
    const newName = (patch.material_name ?? (cur as any)?.material_name ?? '').trim();
    const newCat = patch.category ?? (cur as any)?.category ?? '';
    const newSpec = patch.specification !== undefined ? patch.specification : (cur as any)?.specification;
    if (newName && newCat) {
      const dup = await findExactDuplicateMaterial(supabase, newName, newCat, newSpec as any, id);
      if (dup) return { error: `已有同名同类别同规格物料「${dup.material_name}」(${dup.material_code || '无编码'}),不能改成重复 — 变体请用不同规格区分` };
    }
  }
  const upd: any = { updated_at: new Date().toISOString() };
  if (patch.material_name !== undefined) upd.material_name = patch.material_name?.trim();
  if (patch.category !== undefined) upd.category = patch.category;
  if (patch.default_unit !== undefined) upd.default_unit = patch.default_unit || null;
  if (patch.default_consumption !== undefined) upd.default_consumption = num(patch.default_consumption);
  if (patch.default_supplier_name !== undefined) upd.default_supplier_name = patch.default_supplier_name || null;
  if (patch.default_lead_days !== undefined) upd.default_lead_days = num(patch.default_lead_days);
  if (patch.specification !== undefined) upd.specification = patch.specification || null;
  if (patch.default_loss_rate !== undefined) upd.default_loss_rate = num(patch.default_loss_rate);
  if (patch.reference_price !== undefined) upd.reference_price = num(patch.reference_price);
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

/**
 * 删物料(硬删,受控)。被 BOM/采购/库存预留/产品模板 引用 → 拒绝并建议归档;
 * 无引用 → 硬删(自身供应链数据 material_supplier/uom/alternative 级联删除)。
 */
export async function deleteMaterialMaster(id: string): Promise<{ deleted?: boolean; referenced?: string[]; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const roles = await rolesOf(supabase, user.id);
  if (!roles.some(r => MANAGE_ROLES.includes(r))) return { error: '仅理单/采购/管理员可删除物料' };

  // 引用面检查(都是 material_master_id 外键;inventory_transactions 走文本不查)
  const refTables: Array<[string, string]> = [
    ['materials_bom', '订单BOM'],
    ['procurement_items', '采购归并项'],
    ['inventory_reservation', '库存预留'],
    ['product_bom_templates', '产品BOM模板'],
  ];
  const referenced: string[] = [];
  for (const [table, label] of refTables) {
    const { count } = await (supabase.from(table) as any)
      .select('id', { count: 'exact', head: true }).eq('material_master_id', id);
    if ((count || 0) > 0) referenced.push(`${label} ${count} 条`);
  }
  if (referenced.length > 0) {
    return { referenced, error: `该物料已被引用(${referenced.join('、')}),不能删除 — 可用「归档」让它不再出现在录入/搜索中` };
  }

  const { data: deleted, error } = await (supabase.from('material_master') as any)
    .delete().eq('id', id).select('id');
  if (error) return { error: friendlyError(error) };
  if (!deleted || deleted.length === 0) {
    return { error: '删除未生效:数据库缺少 DELETE 权限,请先在 Supabase 执行 20260703 迁移 SQL(或先用归档)' };
  }
  revalidatePath('/material-master');
  return { deleted: true };
}

/**
 * Excel 批量导入物料主数据。逐行:名称+类别必填 → 查重(库里 + 本文件内,同名同类别) → 自动赋码插入。
 * 重复不导入(报告里列出)。
 */
export async function bulkImportMaterials(rows: MasterInput[]): Promise<{
  created?: number;
  skipped?: Array<{ row: number; name: string; reason: string }>;
  failed?: Array<{ row: number; name: string; reason: string }>;
  error?: string;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const roles = await rolesOf(supabase, user.id);
  if (!roles.some(r => CREATE_ROLES.includes(r))) return { error: '无权批量导入物料' };
  if (!Array.isArray(rows) || rows.length === 0) return { error: 'Excel 里没有可导入的数据行' };
  if (rows.length > 500) return { error: `一次最多导入 500 行(本次 ${rows.length} 行),请拆分文件` };

  // 一次拉全部正式物料 名称+类别+规格 做查重(同名不同规格=合法变体)
  const { data: existing } = await (supabase.from('material_master') as any)
    .select('material_name, category, specification').eq('status', 'active').eq('is_temporary', false);
  const dupKey = (name: any, cat: any, spec: any) =>
    `${String(name ?? '').trim().toLowerCase()}|${cat || ''}|${String(spec ?? '').trim().toLowerCase()}`;
  const seen = new Set<string>((existing || []).map((m: any) =>
    dupKey(m.material_name, m.category, m.specification)));

  const num = (v: any) => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));
  let created = 0;
  const skipped: Array<{ row: number; name: string; reason: string }> = [];
  const failed: Array<{ row: number; name: string; reason: string }> = [];

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i] || ({} as MasterInput);
    const rowNo = i + 2;                              // Excel 行号(1=表头)
    const name = String(raw.material_name || '').trim();
    const category = String(raw.category || '').trim();
    if (!name) { skipped.push({ row: rowNo, name: '(空)', reason: '物料名称为空' }); continue; }
    if (!category) { skipped.push({ row: rowNo, name, reason: '类别为空' }); continue; }
    const spec = String(raw.specification || '').trim();
    const key = dupKey(name, category, spec);
    if (seen.has(key)) { skipped.push({ row: rowNo, name, reason: '已存在同名同类别同规格物料,跳过' }); continue; }

    const code = await genCode(supabase, category);
    const { error } = await (supabase.from('material_master') as any).insert({
      material_code: code,
      material_name: name,
      category,
      default_unit: String(raw.default_unit || '').trim() || null,
      specification: String(raw.specification || '').trim() || null,
      reference_price: num(raw.reference_price),
      default_loss_rate: num(raw.default_loss_rate),
      default_lead_days: num(raw.default_lead_days),
      is_temporary: false,
      seed_source: 'excel_import',
      created_by: user.id,
    });
    if (error) { failed.push({ row: rowNo, name, reason: friendlyError(error) }); continue; }
    seen.add(key);                                    // 文件内重复也会被拦住
    created += 1;
  }

  revalidatePath('/material-master');
  return { created, skipped, failed };
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
    .select('id, material_name, category, specification, is_temporary').eq('id', id).single();
  if (!m) return { error: '物料不存在' };
  if (!(m as any).is_temporary) return { error: '该物料已是正式主数据' };

  // 完全 同名+同类别+同规格 已有正式物料 → 拒绝转正(force 也不放行),避免转正制造重复
  const dup = await findExactDuplicateMaterial(supabase, (m as any).material_name, (m as any).category, (m as any).specification);
  if (dup) {
    return { error: `已有同名同规格正式物料「${dup.material_name}」(${dup.material_code || '无编码'}),不能重复转正 — 该临时物料请直接归档` };
  }

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
// 🔒 底价红线(2026-07-05 审计 P0):unit_price=大货底价,只有采购/财务/管理员可见。
// 此前本函数对全登录角色返回底价 + /material-master 挂在非 admin 导航 → 业务/生产/QC 都能看底价。
// 修①(app 层):非 CAN_SEE_PROCUREMENT_FLOOR 角色一律剥 unit_price(其余供应商信息可看)。
// 修②(DB 硬化 2026-07-05):unit_price 列级 REVOKE 后 user-session 直连该列会 permission denied,
//   故价读改走 service-role(绕过列 REVOKE),再在 app 层按 canFloor 屏蔽 → 直连堵死、能力不变。
export async function listMaterialSuppliers(materialMasterId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const roles = await rolesOf(supabase, user.id);
  const { hasRoleInGroup } = await import('@/lib/domain/roles');
  const canFloor = hasRoleInGroup(roles, 'CAN_SEE_PROCUREMENT_FLOOR');
  const svc = createServiceRoleClient();
  const { data, error } = await (svc.from('material_supplier') as any)
    .select('id, supplier_id, unit_price, currency, lead_days, moq, purchase_unit, is_preferred, last_quoted_at, note, suppliers(name)')
    .eq('material_master_id', materialMasterId)
    .order('is_preferred', { ascending: false });
  if (error) return { error: friendlyError(error) };
  return { data: (data || []).map((r: any) => ({
    ...r,
    unit_price: canFloor ? r.unit_price : null,   // 非采购/财务:屏蔽大货底价
    supplier_name: r.suppliers?.name || null,
  })) };
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
