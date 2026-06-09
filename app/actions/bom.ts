'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

export async function getBomItems(orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: null, error: '请先登录' };
  const { data, error } = await (supabase.from('materials_bom') as any)
    .select('*').eq('order_id', orderId).order('material_type');
  if (error) return { data: null, error: error.message };
  return { data, error: null };
}

export async function addBomItem(orderId: string, item: {
  material_name: string; material_type: string;
  material_code?: string; qty_per_piece?: number; total_qty?: number;
  unit?: string; supplier?: string;
  placement?: string; color?: string; spec?: string;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!item.material_name?.trim()) return { error: '物料名称不能为空' };

  const { error } = await (supabase.from('materials_bom') as any).insert({
    order_id: orderId, created_by: user.id,
    material_name: item.material_name.trim(),
    material_type: item.material_type || 'other',
    material_code: item.material_code || null,
    qty_per_piece: item.qty_per_piece || null,
    total_qty: item.total_qty || null,
    unit: item.unit || 'meter',
    supplier: item.supplier || null,
    placement: item.placement || null,
    color: item.color || null,
    spec: item.spec || null,
  });
  if (error) return { error: error.message };
  revalidatePath(`/orders/${orderId}`);
  return {};
}

export async function updateBomItem(id: string, orderId: string, patch: Record<string, any>) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { error } = await (supabase.from('materials_bom') as any)
    .update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) return { error: error.message };
  revalidatePath(`/orders/${orderId}`);
  return {};
}

export async function deleteBomItem(id: string, orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { error } = await (supabase.from('materials_bom') as any).delete().eq('id', id);
  if (error) return { error: error.message };
  revalidatePath(`/orders/${orderId}`);
  return {};
}

// ===== Customer Trim Library 带入（库=母版，订单=快照） =====
// 从 customer_trim_library 一键复制规格类字段到本单 materials_bom。
// 禁止复制订单级字段（total_qty / unit_cost / material_code）；同名（material_name+placement+color）跳过不覆盖。

function dedupKey(name: any, placement: any, color: any): string {
  const norm = (v: any) => (v ?? '').toString().trim().toLowerCase();
  return `${norm(name)}|${norm(placement)}|${norm(color)}`;
}

/** 列出某订单所属客户在库里可带入的品牌（供带入弹窗选择）。null brand = 通用。 */
export async function getTrimLibraryBrands(orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: null, error: '请先登录' };

  const { data: order, error: oErr } = await (supabase.from('orders') as any)
    .select('customer_name').eq('id', orderId).single();
  if (oErr) return { data: null, error: oErr.message };
  const customerName = order?.customer_name;
  if (!customerName) return { data: null, error: '该订单未关联客户，无法带入' };

  const { data, error } = await (supabase.from('customer_trim_library') as any)
    .select('brand').eq('customer_name', customerName).eq('active', true);
  if (error) return { data: null, error: error.message };

  let hasGeneric = false;
  const brandSet = new Set<string>();
  for (const r of data || []) {
    if (r.brand == null || r.brand === '') hasGeneric = true;
    else brandSet.add(r.brand);
  }
  return {
    data: {
      customerName,
      brands: Array.from(brandSet).sort(),
      hasGeneric,           // 是否有「通用」(brand 为空) 辅料
      total: (data || []).length,
    },
    error: null,
  };
}

/**
 * 带入：brand 为具体品牌 → 复制该品牌 + 通用(brand 空)；brand 为 null → 仅复制通用。
 * 返回 { inserted, skipped }。
 */
export async function importFromTrimLibrary(orderId: string, brand: string | null) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: order, error: oErr } = await (supabase.from('orders') as any)
    .select('customer_name').eq('id', orderId).single();
  if (oErr) return { error: oErr.message };
  const customerName = order?.customer_name;
  if (!customerName) return { error: '该订单未关联客户，无法带入' };

  // 1) 拉库（该客户全部 active），在内存按品牌过滤，避免品牌名含特殊字符破坏 PostgREST or() 语法。
  //    具体品牌 → 含通用(brand 空)；选「通用」(brand=null) → 仅通用。
  const { data: allRows, error: lErr } = await (supabase.from('customer_trim_library') as any)
    .select('*').eq('customer_name', customerName).eq('active', true);
  if (lErr) return { error: lErr.message };
  const libRows = (allRows || []).filter((r: any) => {
    const isGeneric = r.brand == null || r.brand === '';
    return brand ? (isGeneric || r.brand === brand) : isGeneric;
  });
  if (libRows.length === 0) return { inserted: 0, skipped: 0 };

  // 2) 本单现有 BOM → 去重集合
  const { data: existing, error: eErr } = await (supabase.from('materials_bom') as any)
    .select('material_name, placement, color').eq('order_id', orderId);
  if (eErr) return { error: eErr.message };
  const seen = new Set<string>((existing || []).map((b: any) => dedupKey(b.material_name, b.placement, b.color)));

  // 3) 过滤同名 + 库内自去重，组装插入行（不带 total_qty / unit_cost / material_code）
  const toInsert: any[] = [];
  let skipped = 0;
  for (const r of libRows) {
    const key = dedupKey(r.material_name, r.placement, r.color);
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);
    toInsert.push({
      order_id: orderId,
      created_by: user.id,
      material_name: r.material_name,
      material_type: r.material_type || 'other',
      placement: r.placement ?? null,
      color: r.color ?? null,
      qty_per_piece: r.qty_per_piece ?? null,
      unit: r.unit || 'meter',
      supplier: r.supplier ?? null,
      spec: r.spec ?? null,
      notes: r.notes ?? null,
    });
  }

  if (toInsert.length === 0) return { inserted: 0, skipped };

  const { error: iErr } = await (supabase.from('materials_bom') as any).insert(toInsert);
  if (iErr) return { error: iErr.message };

  revalidatePath(`/orders/${orderId}`);
  return { inserted: toInsert.length, skipped };
}
