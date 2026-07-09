'use server';

/**
 * Product Domain（Digital Product Definition)—— Phase 1 最小闭环。
 * Product / Variant / Definition / BOM Template 的建/列/录 + 订单行选 Variant。
 * 红线:只读复用 Material Master;不碰 O1(materials_bom/material_master 表)/B1/P1′/线上订单主逻辑;
 *   不做实例化/Override/Pattern/Sample/Cost/AI(Phase 2)。权限:仅登录(Phase 1 不收紧)。
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { friendlyError } from '@/lib/utils/db-error';

const num = (v: any) => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));

// ════════ Product（款)════════
export async function listProducts(search?: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  let q = (supabase.from('products') as any)
    .select('id, product_code, product_name, category, season, brand, target_customer, status')
    .neq('status', 'archived');
  const s = (search || '').replace(/[%,()]/g, ' ').trim();
  if (s) q = q.or(`product_name.ilike.%${s}%,product_code.ilike.%${s}%,brand.ilike.%${s}%`);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(200);
  if (error) return { error: friendlyError(error) };
  return { data: data || [] };
}

/** 建款:同时建 Definition v1(draft),让 BOM Template 立刻可录。 */
export async function createProduct(input: {
  product_name: string; product_code?: string; category?: string; season?: string; brand?: string; target_customer?: string;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!input.product_name?.trim()) return { error: '款名不能为空' };

  const { data: p, error } = await (supabase.from('products') as any).insert({
    product_name: input.product_name.trim(),
    product_code: input.product_code?.trim() || null,
    category: input.category || null, season: input.season || null,
    brand: input.brand || null, target_customer: input.target_customer || null,
    status: 'developing', created_by: user.id,
  }).select('id').single();
  if (error || !p) return { error: friendlyError(error) };

  await (supabase.from('product_definitions') as any)
    .insert({ product_id: (p as any).id, version: 1, status: 'draft', created_by: user.id });
  revalidatePath('/products');
  return { data: { id: (p as any).id } };
}

/** 款详情:product + variants + 最新 definition + bom template 行。 */
export async function getProductDetail(productId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: product, error: pErr } = await (supabase.from('products') as any)
    .select('*').eq('id', productId).single();
  if (pErr) return { error: friendlyError(pErr) };

  const { data: variants } = await (supabase.from('product_variants') as any)
    .select('*').eq('product_id', productId).order('created_at');

  const { data: defs } = await (supabase.from('product_definitions') as any)
    .select('*').eq('product_id', productId).order('version', { ascending: false }).limit(1);
  const definition = (defs || [])[0] || null;

  let bom: any[] = [];
  if (definition) {
    const { data: rows } = await (supabase.from('product_bom_templates') as any)
      .select('*').eq('definition_id', definition.id).order('created_at');
    bom = rows || [];
  }
  return { data: { product, variants: variants || [], definition, bom } };
}

// ════════ Variant ════════
export async function createVariant(productId: string, input: {
  variant_code?: string; country?: string; market?: string; brand?: string; customer?: string;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { error } = await (supabase.from('product_variants') as any).insert({
    product_id: productId,
    variant_code: input.variant_code?.trim() || null,
    country: input.country || null, market: input.market || null,
    brand: input.brand || null, customer: input.customer || null,
    status: 'active', created_by: user.id,
  });
  if (error) return { error: friendlyError(error) };
  revalidatePath('/products');
  return { ok: true };
}

// ════════ Definition + BOM Template ════════
export async function confirmDefinition(definitionId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { error } = await (supabase.from('product_definitions') as any)
    .update({ status: 'active', confirmed_by: user.id, confirmed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', definitionId);
  if (error) return { error: friendlyError(error) };
  revalidatePath('/products');
  return { ok: true };
}

export async function addBomTemplateRow(definitionId: string, input: {
  material_master_id?: string | null; material_name: string; category?: string; bom_role?: string; unit?: string;
  development_consumption?: any; production_consumption?: any; default_color?: string; default_placement?: string; special_requirements?: string;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!input.material_name?.trim()) return { error: '物料名称不能为空' };
  const { error } = await (supabase.from('product_bom_templates') as any).insert({
    definition_id: definitionId,
    material_master_id: input.material_master_id || null,
    material_name: input.material_name.trim(),
    category: input.category || null, bom_role: input.bom_role || null, unit: input.unit || null,
    development_consumption: num(input.development_consumption),
    production_consumption: num(input.production_consumption),
    default_color: input.default_color || null, default_placement: input.default_placement || null,
    special_requirements: input.special_requirements || null,
  });
  if (error) return { error: friendlyError(error) };
  revalidatePath('/products');
  return { ok: true };
}

export async function deleteBomTemplateRow(id: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { error } = await (supabase.from('product_bom_templates') as any).delete().eq('id', id);
  if (error) return { error: friendlyError(error) };
  revalidatePath('/products');
  return { ok: true };
}

// ════════ 订单行 ↔ Variant（1b)════════
/** 列订单的款色码行 + 当前关联的 Variant 标签。 */
export async function getOrderLines(orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data: lines, error } = await (supabase.from('order_line_items') as any)
    .select('id, line_no, style_no, product_name, color_cn, color_en, sizes, qty_pcs, unit, product_variant_id')
    .eq('order_id', orderId).order('line_no');
  if (error) return { error: friendlyError(error) };

  // 解析当前 variant 标签(分步,避免深层嵌套 join)
  const vIds = Array.from(new Set((lines || []).map((l: any) => l.product_variant_id).filter(Boolean)));
  const vMap = new Map<string, string>();
  if (vIds.length) {
    const { data: vs } = await (supabase.from('product_variants') as any)
      .select('id, variant_code, country, customer, product_id').in('id', vIds);
    const pIds = Array.from(new Set((vs || []).map((v: any) => v.product_id).filter(Boolean)));
    const pMap = new Map<string, any>();
    if (pIds.length) {
      const { data: ps } = await (supabase.from('products') as any).select('id, product_code, product_name').in('id', pIds);
      for (const p of (ps || [])) pMap.set(p.id, p);
    }
    for (const v of (vs || [])) {
      const p = pMap.get(v.product_id);
      vMap.set(v.id, `${p?.product_code || p?.product_name || '款'} · ${[v.country, v.customer, v.variant_code].filter(Boolean).join('/') || '默认'}`);
    }
  }
  const result = (lines || []).map((l: any) => ({ ...l, variant_label: l.product_variant_id ? (vMap.get(l.product_variant_id) || '—') : null }));
  return { data: result };
}

/** 搜款变体(给订单行选择)。 */
export async function searchProductVariants(search?: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data: vs } = await (supabase.from('product_variants') as any)
    .select('id, variant_code, country, market, customer, product_id').eq('status', 'active').limit(100);
  const pIds = Array.from(new Set((vs || []).map((v: any) => v.product_id).filter(Boolean)));
  const pMap = new Map<string, any>();
  if (pIds.length) {
    const { data: ps } = await (supabase.from('products') as any).select('id, product_code, product_name, brand').in('id', pIds);
    for (const p of (ps || [])) pMap.set(p.id, p);
  }
  const s = (search || '').trim().toLowerCase();
  const rows = (vs || []).map((v: any) => {
    const p = pMap.get(v.product_id) || {};
    return { id: v.id, label: `${p.product_code || ''} ${p.product_name || ''}`.trim(),
      sub: [v.country, v.customer, v.market, v.variant_code].filter(Boolean).join('/') || '默认',
      _hay: `${p.product_code || ''} ${p.product_name || ''} ${p.brand || ''} ${v.country || ''} ${v.customer || ''}`.toLowerCase() };
  }).filter((r: any) => !s || r._hay.includes(s)).slice(0, 30);
  return { data: rows };
}

export async function setOrderLineVariant(orderLineId: string, variantId: string | null, orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { error } = await (supabase.from('order_line_items') as any)
    .update({ product_variant_id: variantId || null, updated_at: new Date().toISOString() }).eq('id', orderLineId);
  if (error) return { error: friendlyError(error) };
  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}
