'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { computeMaterialRequirement } from '@/lib/services/mrp';
import { subtractWorkingDays } from '@/lib/utils/date';

const toYmd = (d: Date) => d.toISOString().slice(0, 10);

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
// 采购流 B1:业务「提交采购」→ 锁 BOM + 冻 Snapshot + 建 Material Plan + 跑 Explainable MRP 生成需求
// 红线:不生成 procurement_line_items、不下单/询价/验收、不改采购主流程、不改前端。
// ════════════════════════════════════════════════

/** 内容签名(变更检测用):同一组物料行 → 同一字符串 */
function bomSignature(rows: any[], f: { name: string; type: string; code: string; qpp: string; unit: string; color: string; place: string; spec: string; supplier: string }): string {
  return JSON.stringify(
    rows.map(r => [r[f.name], r[f.type], r[f.code], r[f.qpp], r[f.unit], r[f.color], r[f.place], r[f.spec], r[f.supplier]]).sort()
  );
}

export async function submitBomToProcurement(
  orderId: string,
): Promise<{ ok?: boolean; count?: number; error?: string; plan_id?: string; snapshot_version?: number; requirement_count?: number }> {
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

  // 订单(MRP 输入:数量 + 阶段日期兜底)
  const { data: order } = await (supabase.from('orders') as any)
    .select('id, order_no, customer_name, quantity, factory_date, etd').eq('id', orderId).single();
  if (!order) return { error: '订单不存在' };
  if (!order.quantity || order.quantity <= 0) return { error: '订单缺数量,无法生成物料需求' };

  // live BOM(完整列,用于冻结快照)
  const { data: bomRows, error: bomErr } = await (supabase.from('materials_bom') as any)
    .select('id, material_name, material_type, material_code, qty_per_piece, unit, color, placement, spec, supplier')
    .eq('order_id', orderId);
  if (bomErr) return { error: bomErr.message };
  if (!bomRows || bomRows.length === 0) return { error: '原辅料单为空,请先录入物料再提交' };

  // 损耗率(来自成本基线,缺则默认 3)
  const { data: baseline } = await (supabase.from('order_cost_baseline') as any)
    .select('waste_pct').eq('order_id', orderId).maybeSingle();
  const waste_pct = (baseline as any)?.waste_pct ?? 3;

  // 阶段锚点日(复用现有里程碑日期 = One Data)
  const { data: ms } = await (supabase.from('milestones') as any)
    .select('step_key, due_at').eq('order_id', orderId);
  const dOf = (k: string): string | null => {
    const m = (ms || []).find((x: any) => x.step_key === k);
    return m?.due_at ? String(m.due_at).slice(0, 10) : null;
  };
  const factory_date = order.factory_date ? String(order.factory_date).slice(0, 10) : null;
  const etd = order.etd ? String(order.etd).slice(0, 10) : null;
  // packing 优先级:packing 节点 → 出货前 buffer(etd−3 工作日)→ factory_completion → factory_date 兜底
  const packingDate = dOf('packing_method_confirmed')
    || (etd ? toYmd(subtractWorkingDays(new Date(etd + 'T00:00:00+08:00'), 3)) : null)
    || dOf('factory_completion')
    || factory_date;
  const stageAnchors = {
    cutting: dOf('production_kickoff') || factory_date,
    sewing: dOf('production_kickoff') || factory_date,
    packing: packingDate,
    shipment: dOf('booking_done') || dOf('shipment_execute') || etd,
    sample: dOf('pre_production_sample_approved'),
    factory_date,
  };

  const now = new Date().toISOString();

  // ── a. 锁定 BOM ──
  const { error: lockErr } = await (supabase.from('materials_bom') as any)
    .update({ submit_status: 'submitted', submitted_at: now, submitted_by: user.id })
    .eq('order_id', orderId);
  if (lockErr) return { error: `锁定 BOM 失败:${lockErr.message}` };

  // ── b. 冻结 Snapshot(含变更检测:BOM 未变则复用最新版本)──
  const liveSig = bomSignature(bomRows, { name: 'material_name', type: 'material_type', code: 'material_code', qpp: 'qty_per_piece', unit: 'unit', color: 'color', place: 'placement', spec: 'spec', supplier: 'supplier' });
  const { data: latestSnap } = await (supabase.from('material_package_snapshots') as any)
    .select('id, version').eq('order_id', orderId).eq('status', 'approved')
    .order('version', { ascending: false }).limit(1).maybeSingle();

  let snapshotId: string;
  let snapshotVersion: number;
  let reuseSnap = false;
  if (latestSnap) {
    const { data: latestLines } = await (supabase.from('material_package_snapshot_lines') as any)
      .select('material_name, material_type, material_code, qty_per_piece, unit, color, placement, specification, suggested_supplier')
      .eq('snapshot_id', (latestSnap as any).id);
    const snapSig = bomSignature(latestLines || [], { name: 'material_name', type: 'material_type', code: 'material_code', qpp: 'qty_per_piece', unit: 'unit', color: 'color', place: 'placement', spec: 'specification', supplier: 'suggested_supplier' });
    if (snapSig === liveSig) { reuseSnap = true; snapshotId = (latestSnap as any).id; snapshotVersion = (latestSnap as any).version; }
  }

  if (!reuseSnap) {
    snapshotVersion = ((latestSnap as any)?.version || 0) + 1;
    if (latestSnap) {
      await (supabase.from('material_package_snapshots') as any).update({ status: 'superseded' }).eq('id', (latestSnap as any).id);
    }
    const { data: newSnap, error: snapErr } = await (supabase.from('material_package_snapshots') as any).insert({
      order_id: orderId, version: snapshotVersion, status: 'approved',
      snapshot_no: `MPS-${order.order_no}-v${snapshotVersion}`,
      supersedes_snapshot_id: (latestSnap as any)?.id || null,
      source_bom_count: bomRows.length,
      submitted_by: user.id, submitted_at: now, approved_by: user.id, approved_at: now, created_by: user.id,
    }).select('id').single();
    if (snapErr || !newSnap) return { error: `快照创建失败:${snapErr?.message}` };
    snapshotId = (newSnap as any).id;
    const lineRows = bomRows.map((r: any) => ({
      snapshot_id: snapshotId, order_id: orderId, bom_id: r.id,
      material_name: r.material_name, material_type: r.material_type, material_code: r.material_code,
      specification: r.spec, color: r.color, placement: r.placement,
      qty_per_piece: r.qty_per_piece, unit: r.unit, loss_rate: waste_pct,
      suggested_supplier: r.supplier, sample_status: null, remarks: null,
    }));
    const { error: lineErr } = await (supabase.from('material_package_snapshot_lines') as any).insert(lineRows);
    if (lineErr) return { error: `快照行创建失败:${lineErr.message}` };
  }

  // ── c. material_plan upsert(1:1 订单)──
  const { data: existingPlan } = await (supabase.from('material_plans') as any)
    .select('id').eq('order_id', orderId).maybeSingle();
  let planId: string;
  if (existingPlan) {
    await (supabase.from('material_plans') as any)
      .update({ snapshot_id: snapshotId!, plan_status: 'active', mrp_generated_at: now, updated_at: now })
      .eq('id', (existingPlan as any).id);
    planId = (existingPlan as any).id;
  } else {
    const { data: newPlan, error: planErr } = await (supabase.from('material_plans') as any)
      .insert({ order_id: orderId, snapshot_id: snapshotId!, plan_status: 'active', mrp_generated_at: now }).select('id').single();
    if (planErr || !newPlan) return { error: `计划创建失败:${planErr?.message}` };
    planId = (newPlan as any).id;
  }

  // ── d. 重算 material_requirements(B1:该 plan 下需求均无采购引用,安全删重建)──
  await (supabase.from('material_requirements') as any).delete().eq('material_plan_id', planId);
  const { data: snapLines } = await (supabase.from('material_package_snapshot_lines') as any)
    .select('*').eq('snapshot_id', snapshotId!);
  const today = toYmd(new Date());
  const reqRows = (snapLines || []).map((line: any) => {
    const r = computeMaterialRequirement({
      material: {
        material_name: line.material_name, material_type: line.material_type,
        material_code: line.material_code, unit: line.unit,
        qty_per_piece: line.qty_per_piece, loss_rate: line.loss_rate,
      },
      po_quantity: order.quantity, stageAnchors, inventoryQty: 0, reuseQty: 0, today,
    });
    return {
      material_plan_id: planId, order_id: orderId, snapshot_line_id: line.id,
      material_name: r.material_name, material_type: r.material_type, category: r.category,
      material_code: r.material_code, unit: r.unit,
      gross_requirement: r.gross_requirement, loss_qty: r.loss_qty,
      inventory_deduct: r.inventory_deduct, reuse_deduct: r.reuse_deduct, net_purchase_qty: r.net_purchase_qty,
      required_stage: r.required_stage, required_date: r.required_date,
      supplier_lead_days: r.supplier_lead_days, order_by_date: r.order_by_date, timing_status: r.timing_status,
      explain_json: r.explain_json, status: r.status === 'needs_input' ? 'open' : r.status,
      last_recomputed_at: now,
    };
  });
  if (reqRows.length > 0) {
    const { error: reqErr } = await (supabase.from('material_requirements') as any).insert(reqRows);
    if (reqErr) return { error: `物料需求生成失败:${reqErr.message}` };
  }

  // ── e. 通知采购(fire-and-forget,失败不阻断)──
  try {
    const { data: procs } = await (supabase.from('profiles') as any)
      .select('user_id')
      .or('role.eq.procurement,roles.cs.{procurement},role.eq.procurement_manager,roles.cs.{procurement_manager}');
    const ids = Array.from(new Set(((procs || []) as any[]).map(p => p.user_id).filter(Boolean)));
    const submitter = (profile as any)?.name || user.email?.split('@')[0] || '业务';
    for (const uid of ids) {
      await (supabase.from('notifications') as any).insert({
        user_id: uid,
        type: 'bom_submitted_to_procurement',
        title: `🧵 原辅料单已提交 — ${order.order_no || ''}`,
        message: `客户：${order.customer_name || '?'}\n${submitter} 提交了原辅料单(${bomRows.length} 项物料)。系统已自动生成采购需求(${reqRows.length} 项),请到「采购 / 供应链」确认、询价、下单。`,
        related_order_id: orderId,
        status: 'unread',
      });
    }
  } catch (e: any) {
    console.warn('[submitBomToProcurement] 通知采购失败(不阻断):', e?.message);
  }

  revalidatePath(`/orders/${orderId}`);
  return { ok: true, count: bomRows.length, plan_id: planId, snapshot_version: snapshotVersion!, requirement_count: reqRows.length };
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
