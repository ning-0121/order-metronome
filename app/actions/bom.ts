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

// ════════════════════════════════════════════════
// 采购流 Step A:业务「提交采购」+ 已交样标记(只动 materials_bom,不碰采购主流程)
// ════════════════════════════════════════════════

/**
 * 业务提交原辅料单给采购:把本订单所有 BOM 行标为已提交,并通知采购去汇总/询价/下单。
 * 这是采购流的"起点"。不下采购单、不改采购状态机,仅标记 + 通知。
 */
export async function submitBomToProcurement(
  orderId: string,
): Promise<{ ok?: boolean; count?: number; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  // 权限:业务/理单/业务经理/订单经理/管理员可提交
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles, name').eq('user_id', user.id).single();
  const roles: string[] = (profile as any)?.roles?.length > 0
    ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  const canSubmit = roles.some(r => ['sales', 'merchandiser', 'sales_manager', 'order_manager', 'admin'].includes(r));
  if (!canSubmit) return { error: '仅业务/理单/管理员可提交原辅料单' };

  // 必须先有 BOM 才能提交
  const { data: bomRows, error: bomErr } = await (supabase.from('materials_bom') as any)
    .select('id').eq('order_id', orderId);
  if (bomErr) return { error: bomErr.message };
  if (!bomRows || bomRows.length === 0) return { error: '原辅料单为空,请先录入物料再提交' };

  // 标记本订单 BOM 已提交采购
  const { error: updErr } = await (supabase.from('materials_bom') as any)
    .update({ submit_status: 'submitted', submitted_at: new Date().toISOString(), submitted_by: user.id })
    .eq('order_id', orderId);
  if (updErr) return { error: updErr.message };

  // 通知采购(fire-and-forget,失败不阻断提交)
  try {
    const { data: order } = await (supabase.from('orders') as any)
      .select('order_no, customer_name').eq('id', orderId).single();
    const { data: procs } = await (supabase.from('profiles') as any)
      .select('user_id')
      .or('role.eq.procurement,roles.cs.{procurement},role.eq.procurement_manager,roles.cs.{procurement_manager}');
    const ids = Array.from(new Set(((procs || []) as any[]).map(p => p.user_id).filter(Boolean)));
    const submitter = (profile as any)?.name || user.email?.split('@')[0] || '业务';
    for (const uid of ids) {
      await (supabase.from('notifications') as any).insert({
        user_id: uid,
        type: 'bom_submitted_to_procurement',
        title: `🧵 原辅料单已提交 — ${order?.order_no || ''}`,
        message: `客户：${order?.customer_name || '?'}\n${submitter} 提交了原辅料单(${bomRows.length} 项物料)。请到「采购 / 供应链」按 PO 数量汇总、询价、下单。`,
        related_order_id: orderId,
        status: 'unread',
      });
    }
  } catch (e: any) {
    console.warn('[submitBomToProcurement] 通知采购失败(不阻断):', e?.message);
  }

  revalidatePath(`/orders/${orderId}`);
  return { ok: true, count: bomRows.length };
}

/** 标记某物料"已交样品给采购"(线下样品的轻量标记) */
export async function setBomSampleGiven(
  id: string,
  orderId: string,
  given: boolean,
): Promise<{ ok?: boolean; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { error } = await (supabase.from('materials_bom') as any)
    .update({ sample_given: given }).eq('id', id).eq('order_id', orderId);
  if (error) return { error: error.message };
  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}
