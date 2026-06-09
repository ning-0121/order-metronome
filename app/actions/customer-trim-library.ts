'use server';

/**
 * Customer Trim Library — 客户标准辅料母版库（Customer Specification Library Phase 1）。
 * [SHARED] 通用模块：客户×品牌级标准辅料母版，建单时一键带入订单（见 app/actions/bom.ts importFromTrimLibrary）。
 *
 * 核心原则：库=母版，订单=快照。本文件只维护母版，带入复制逻辑在 bom.ts。
 * 键用 customer_name（与 customer_rhythm 一致，松耦合，无 FK）。brand 可空 = 该客户通用。
 * 「删除」走软删除 active=false：配合 active 部分唯一索引，停用后可建同名新版本。
 */

import { createClient } from '@/lib/supabase/server';

export interface TrimLibraryItem {
  id: string;
  customer_name: string;
  brand: string | null;
  material_name: string;
  material_type: string;
  placement: string | null;
  color: string | null;
  qty_per_piece: number | null;
  unit: string | null;
  supplier: string | null;
  spec: string | null;
  notes: string | null;
  sort_order: number;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export type TrimItemInput = {
  brand?: string | null;
  material_name: string;
  material_type?: string;
  placement?: string | null;
  color?: string | null;
  qty_per_piece?: number | null;
  unit?: string | null;
  supplier?: string | null;
  spec?: string | null;
  notes?: string | null;
  sort_order?: number;
};

const VALID_TYPES = ['fabric', 'trim', 'lining', 'label', 'packing', 'other'];

function clean(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
}

/** 列出某客户全部 active 母版辅料（所有品牌 + 通用），按 brand/sort_order 排序。 */
export async function listTrimLibrary(customerName: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: null, error: '请先登录' };
  if (!customerName?.trim()) return { data: null, error: '缺少客户名' };

  const { data, error } = await (supabase.from('customer_trim_library') as any)
    .select('*')
    .eq('customer_name', customerName)
    .eq('active', true)
    .order('brand', { ascending: true, nullsFirst: true })
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) return { data: null, error: error.message };
  return { data: data as TrimLibraryItem[], error: null };
}

export async function addTrimItem(customerName: string, item: TrimItemInput) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!customerName?.trim()) return { error: '缺少客户名' };
  if (!item.material_name?.trim()) return { error: '物料名称不能为空' };
  const material_type = item.material_type || 'other';
  if (!VALID_TYPES.includes(material_type)) return { error: '物料类型非法' };

  const { error } = await (supabase.from('customer_trim_library') as any).insert({
    customer_name: customerName.trim(),
    brand: clean(item.brand),
    material_name: item.material_name.trim(),
    material_type,
    placement: clean(item.placement),
    color: clean(item.color),
    qty_per_piece: item.qty_per_piece ?? null,
    unit: clean(item.unit),
    supplier: clean(item.supplier),
    spec: clean(item.spec),
    notes: clean(item.notes),
    sort_order: item.sort_order ?? 0,
    created_by: user.id,
  });

  // 唯一索引冲突（同客户+品牌+名称+部位+颜色已有 active 记录）
  if (error) {
    if ((error as any).code === '23505') return { error: '该辅料已存在（同品牌/部位/颜色），请勿重复添加' };
    return { error: error.message };
  }
  return {};
}

export async function updateTrimItem(id: string, patch: TrimItemInput) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (patch.material_name !== undefined && !patch.material_name.trim()) return { error: '物料名称不能为空' };
  if (patch.material_type !== undefined && !VALID_TYPES.includes(patch.material_type)) return { error: '物料类型非法' };

  const update: Record<string, any> = { updated_at: new Date().toISOString() };
  if (patch.brand !== undefined) update.brand = clean(patch.brand);
  if (patch.material_name !== undefined) update.material_name = patch.material_name.trim();
  if (patch.material_type !== undefined) update.material_type = patch.material_type;
  if (patch.placement !== undefined) update.placement = clean(patch.placement);
  if (patch.color !== undefined) update.color = clean(patch.color);
  if (patch.qty_per_piece !== undefined) update.qty_per_piece = patch.qty_per_piece ?? null;
  if (patch.unit !== undefined) update.unit = clean(patch.unit);
  if (patch.supplier !== undefined) update.supplier = clean(patch.supplier);
  if (patch.spec !== undefined) update.spec = clean(patch.spec);
  if (patch.notes !== undefined) update.notes = clean(patch.notes);
  if (patch.sort_order !== undefined) update.sort_order = patch.sort_order;

  const { error } = await (supabase.from('customer_trim_library') as any).update(update).eq('id', id);
  if (error) {
    if ((error as any).code === '23505') return { error: '与已有辅料冲突（同品牌/部位/颜色）' };
    return { error: error.message };
  }
  return {};
}

/** 软删除/恢复：停用走 active=false（保留历史，配合部分唯一索引可建新版本）。 */
export async function setTrimItemActive(id: string, active: boolean) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { error } = await (supabase.from('customer_trim_library') as any)
    .update({ active, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) return { error: error.message };
  return {};
}
