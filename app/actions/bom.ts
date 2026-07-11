'use server';

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { computeMaterialRequirement } from '@/lib/services/mrp';
import { aggregateInventoryBalance, reservedByKey } from '@/lib/services/inventory';
import { consolidationKey } from '@/lib/services/procurement-consolidation';
import { subtractWorkingDays } from '@/lib/utils/date';
import { requireRoleGroup } from '@/lib/domain/requireRole';

const toYmd = (d: Date) => d.toISOString().slice(0, 10);

export async function getBomItems(orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: null, error: '请先登录' };
  const { data, error } = await (supabase.from('materials_bom') as any)
    .select('*').eq('order_id', orderId).order('material_type');
  if (error) return { data: null, error: error.message };

  // 派生「总需用量」:单件用量 × 件数(件数来自 order_line_items,按 款×色 匹配,
  // 与 submitBomToProcurement 同口径 → 展示即将来真实采购基数,不做第二套算法)。
  // 只读派生,不写库;total_qty 若人工填了则以人工为准(computed 仅兜底/对照)。
  try {
    const rows = (data || []) as any[];
    const { data: order } = await (supabase.from('orders') as any)
      .select('quantity').eq('id', orderId).maybeSingle();
    const orderQty = Number((order as any)?.quantity) || 0;
    const { data: liRows } = await (supabase.from('order_line_items') as any)
      .select('style_no, color_cn, color_en, qty_pcs, set_multiplier').eq('order_id', orderId);
    const styleQty = new Map<string, number>();
    const styleColorQty = new Map<string, number>();
    const colorAlias = new Map<string, string>();
    const normColor = (s: any) => String(s ?? '').trim().toLowerCase();
    for (const r of (liRows || []) as any[]) {
      if (!r.style_no) continue;
      // 套装:总件数 = 件数 × 每套件数(set_multiplier;1=非套装)。算料按真实件数,不按套数。
      const q = (Number(r.qty_pcs) || 0) * (Number(r.set_multiplier) > 0 ? Number(r.set_multiplier) : 1);
      styleQty.set(r.style_no, (styleQty.get(r.style_no) || 0) + q);
      const canon = normColor(r.color_cn) || normColor(r.color_en);
      if (!canon) continue;
      const canonKey = `${r.style_no}¦${canon}`;
      styleColorQty.set(canonKey, (styleColorQty.get(canonKey) || 0) + q);
      for (const c of [r.color_cn, r.color_en]) {
        const nc = normColor(c);
        if (nc) colorAlias.set(`${r.style_no}¦${nc}`, canonKey);
      }
    }
    for (const b of rows) {
      // 件数基数:款×色 命中 → 该色件数;款命中 → 该款件数;否则整单数量(与提交同"宁多勿缺")
      let pieces = 0;
      const st = b.style_no || null;
      if (st && String(b.color ?? '').trim()) {
        const bk = `${st}¦${normColor(b.color)}`;
        pieces = styleColorQty.get(colorAlias.get(bk) || bk) || (st && styleQty.get(st)) || orderQty;
      } else if (st && styleQty.get(st)) {
        pieces = styleQty.get(st)!;
      } else {
        pieces = orderQty;
      }
      const qpp = b.qty_per_piece != null ? Number(b.qty_per_piece) : null;
      b.computed_pieces = pieces > 0 ? pieces : null;
      b.computed_total_qty = (qpp != null && qpp > 0 && pieces > 0)
        ? Math.round(qpp * pieces * 100) / 100
        : null;
    }
  } catch (e: any) { console.warn('[getBomItems] 总需派生失败(不阻断):', e?.message); }

  return { data, error: null };
}

export async function addBomItem(orderId: string, item: {
  material_name: string; material_type: string;
  material_code?: string; qty_per_piece?: number; total_qty?: number;
  unit?: string; supplier?: string;
  placement?: string; color?: string; spec?: string;
  notes?: string; special_requirements?: string;
  style_no?: string;   // S1.2:归属款号(空 = 整单通用)
  pack_size?: number;  // 每包件数(打包辅料;需求÷每包件数)
  image_urls?: string[];   // [0]→辅料单「示例画稿」, [1]→「位置说明及示意图」(录料时直接上传)
  attachment_files?: Array<{ name: string; url: string }>;   // 排版稿/文件附件(分款吊卡/箱唛等;录料时直接传)
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  { const _bomErr = await requireRoleGroup(supabase, user.id, 'CAN_EDIT_BOM', '仅业务/采购/管理员可增删改物料清单(BOM)'); if (_bomErr) return { error: _bomErr }; }
  if (!item.material_name?.trim()) return { error: '物料名称不能为空' };

  // 没手填代码 → 自动赋码(同名同类复用主数据码,没有就建主数据生成 FAB/TRM/PKG-xxxx)
  let autoCode: { id: string; code: string } | null = null;
  if (!item.material_code?.trim()) {
    const { ensureMaterialMaster } = await import('@/lib/services/material-autocode');
    autoCode = await ensureMaterialMaster(supabase, user.id, {
      name: item.material_name, category: item.material_type || 'other',
      spec: item.spec, unit: item.unit, supplier: item.supplier,
    });
  }

  const insertRow: Record<string, any> = {
    order_id: orderId, created_by: user.id,
    material_name: item.material_name.trim(),
    material_type: item.material_type || 'other',
    material_code: item.material_code?.trim() || autoCode?.code || null,
    material_master_id: autoCode?.id || null,
    qty_per_piece: item.qty_per_piece || null,
    total_qty: item.total_qty || null,
    unit: item.unit || 'meter',
    supplier: item.supplier || null,
    placement: item.placement || null,
    color: item.color || null,
    spec: item.spec || null,
    notes: item.notes || null,
    special_requirements: item.special_requirements || null,
    style_no: item.style_no?.trim() || null,
    pack_size: item.pack_size != null && item.pack_size > 1 ? item.pack_size : null,   // 每包件数
    image_urls: Array.isArray(item.image_urls) && item.image_urls.some(Boolean) ? item.image_urls : [],  // 辅料单图(示例画稿/示意图);无图给 []——列 NOT NULL,写 null 会违反约束(2026-07-09 修)
    attachment_files: Array.isArray(item.attachment_files) ? item.attachment_files : [],   // 排版稿/文件附件(录料时随行入库)
    source: 'manual',                      // 手动新增(Phase 2A 来源标记)
  };
  let { error } = await (supabase.from('materials_bom') as any).insert(insertRow);
  if (error && /pack_size|attachment_files|column .* does not exist/i.test(error.message || '')) {
    delete insertRow.pack_size;            // 20260707 迁移未跑 → 降级(不 brick 加料)
    delete insertRow.attachment_files;     // 20260710 迁移未跑 → 降级
    ({ error } = await (supabase.from('materials_bom') as any).insert(insertRow));
  }
  if (error) return { error: error.message };
  revalidatePath(`/orders/${orderId}`);
  return {};
}

/**
 * O1b:从 Material Master「选料」录入。
 * 服务端按 masterId 取正式主数据(防客户端伪造物料定义)→ 快照式写入 materials_bom:
 * 物料定义(名/类别→material_type/编码/单位/规格/默认供应商)来自 master;
 * 业务只填逐单字段(单耗/颜色/位置/备注/特殊要求)。写 material_master_id 建立链接。
 * material_type = master.category 直写(CHECK 已扩容至 10 值,B1/MRP 已支持)。
 */
export async function addBomItemFromMaster(orderId: string, masterId: string, perOrder: {
  qty_per_piece?: number; color?: string; placement?: string; notes?: string; special_requirements?: string;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  { const _bomErr = await requireRoleGroup(supabase, user.id, 'CAN_EDIT_BOM', '仅业务/采购/管理员可增删改物料清单(BOM)'); if (_bomErr) return { error: _bomErr }; }
  if (!masterId) return { error: '请选择物料' };

  const { data: m, error: mErr } = await (supabase.from('material_master') as any)
    .select('id, material_code, material_name, category, default_unit, default_consumption, default_supplier_name, specification, is_temporary, status, usage_count')
    .eq('id', masterId).single();
  if (mErr || !m) return { error: '物料主数据不存在' };
  if ((m as any).is_temporary || (m as any).status !== 'active') return { error: '该物料不可选用(临时或已归档)' };

  const qpp = perOrder.qty_per_piece ?? (m as any).default_consumption ?? null;
  const { error } = await (supabase.from('materials_bom') as any).insert({
    order_id: orderId, created_by: user.id,
    material_master_id: (m as any).id,
    material_name: (m as any).material_name,
    material_type: (m as any).category || 'other',   // master.category 直写(CHECK 已扩容)
    material_code: (m as any).material_code || null,
    unit: (m as any).default_unit || 'meter',
    spec: (m as any).specification || null,
    supplier: (m as any).default_supplier_name || null,
    qty_per_piece: qpp,
    color: perOrder.color || null,
    placement: perOrder.placement || null,
    notes: perOrder.notes || null,
    special_requirements: perOrder.special_requirements || null,
  });
  if (error) return { error: error.message };

  // usage_count +1(fire-and-forget,软统计,失败不阻断)
  try {
    await (supabase.from('material_master') as any)
      .update({ usage_count: ((m as any).usage_count ?? 0) + 1 }).eq('id', masterId);
  } catch { /* 忽略 */ }

  revalidatePath(`/orders/${orderId}`);
  return {};
}

/**
 * O1b-2:订单内「创建临时物料」——物料库搜不到时,直接建临时料并加入本单 BOM。
 * 复用 O1a 字段(无新 migration):material_master.is_temporary=true + source_order_id=本单 + 无码,
 * 自动写 materials_bom(material_master_id 指向临时料)。临时料随即出现在「物料主数据 → 待转正」。
 * 权限:仅登录(与 addBomItem 一致;控制点在转正 = promoteTemporaryMaterial 受 Helen/admin 管)。
 */
export async function addTemporaryBomItem(orderId: string, input: {
  material_name: string; category: string;
  default_unit?: string; specification?: string; default_supplier_name?: string;
  qty_per_piece?: number; color?: string; placement?: string; notes?: string; special_requirements?: string;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  { const _bomErr = await requireRoleGroup(supabase, user.id, 'CAN_EDIT_BOM', '仅业务/采购/管理员可增删改物料清单(BOM)'); if (_bomErr) return { error: _bomErr }; }
  if (!input.material_name?.trim()) return { error: '物料名称不能为空' };
  if (!input.category) return { error: '请选择类别' };

  const num = (v: any) => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));
  const qpp = num(input.qty_per_piece);

  // ── 1) 建临时物料(is_temporary=true,无码,挂当前订单)──
  const { data: m, error: mErr } = await (supabase.from('material_master') as any).insert({
    material_name: input.material_name.trim(),
    category: input.category,
    default_unit: input.default_unit || null,
    specification: input.specification || null,
    default_supplier_name: input.default_supplier_name || null,
    default_consumption: qpp,                 // 用本单单耗作默认单耗初值(转正后可改)
    is_temporary: true,
    source_order_id: orderId,
    status: 'active',
    seed_source: 'order_entry',
    created_by: user.id,
  }).select('id').single();
  if (mErr || !m) return { error: `临时物料创建失败:${mErr?.message || '未知'}` };

  // ── 2) 写 materials_bom(链接临时料,material_code 留空)──
  const { error: bErr } = await (supabase.from('materials_bom') as any).insert({
    order_id: orderId, created_by: user.id,
    material_master_id: (m as any).id,
    material_name: input.material_name.trim(),
    material_type: input.category || 'other',
    material_code: null,
    unit: input.default_unit || 'meter',
    spec: input.specification || null,
    supplier: input.default_supplier_name || null,
    qty_per_piece: qpp,
    color: input.color || null,
    placement: input.placement || null,
    notes: input.notes || null,
    special_requirements: input.special_requirements || null,
  });
  if (bErr) {
    // best-effort 删孤儿临时料(RLS 无 DELETE 策略可能拦,无害)
    try { await (supabase.from('material_master') as any).delete().eq('id', (m as any).id); } catch { /* 忽略 */ }
    return { error: `BOM 写入失败:${bErr.message}` };
  }

  revalidatePath(`/orders/${orderId}`);
  return {};
}

/**
 * O1b-3:列出可复制原辅料的历史订单(只含有 BOM 的)。
 * 优先级:同客户 > 同 style_no > 最近;v1 简单实现(同客户∪全局近30 → 过滤有 BOM → top30)。
 */
export async function listCopyableOrders(currentOrderId: string, search?: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: [], error: '请先登录' };

  const { data: cur } = await (supabase.from('orders') as any)
    .select('customer_name, style_no').eq('id', currentOrderId).single();
  const curCustomer = (cur as any)?.customer_name || null;
  const curStyle = (cur as any)?.style_no || null;

  const cols = 'id, order_no, customer_name, style_no, product_name, factory_date, etd, created_at';
  const pool = new Map<string, any>();
  const addAll = (rows: any[]) => { for (const r of rows || []) if (r.id !== currentOrderId) pool.set(r.id, r); };

  // 去掉破坏 PostgREST or() 语法的字符
  const s = (search || '').replace(/[%,()]/g, ' ').trim();
  if (s) {
    const { data } = await (supabase.from('orders') as any)
      .select(cols)
      .or(`order_no.ilike.%${s}%,customer_name.ilike.%${s}%,style_no.ilike.%${s}%,product_name.ilike.%${s}%`)
      .order('created_at', { ascending: false }).limit(50);
    addAll(data);
  } else {
    if (curCustomer) {
      const { data } = await (supabase.from('orders') as any)
        .select(cols).eq('customer_name', curCustomer)
        .order('created_at', { ascending: false }).limit(30);
      addAll(data);
    }
    const { data } = await (supabase.from('orders') as any)
      .select(cols).order('created_at', { ascending: false }).limit(30);
    addAll(data);
  }

  const ids = Array.from(pool.keys());
  if (ids.length === 0) return { data: [] };

  // 统计每单 BOM 行数,过滤 0 行
  const { data: bomRows } = await (supabase.from('materials_bom') as any)
    .select('order_id').in('order_id', ids);
  const countMap = new Map<string, number>();
  for (const b of (bomRows || [])) countMap.set(b.order_id, (countMap.get(b.order_id) || 0) + 1);

  const score = (o: any) => (o.customer_name === curCustomer ? 2 : 0) + (curStyle && o.style_no === curStyle ? 1 : 0);
  const result = ids
    .filter(id => (countMap.get(id) || 0) > 0)
    .map(id => ({ ...pool.get(id), bom_count: countMap.get(id) || 0 }))
    .sort((a, b) => (score(b) - score(a)) || String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 30);

  return { data: result };
}

/**
 * O1b-3:把历史订单 materials_bom 复制到当前订单。
 * 保留 master 链接 + 物料定义 + 逐单字段;不复制 total_qty / 提交状态 / 样品;新行 draft、version 默认 1、created_by=当前用户。
 * mode='replace' 先清当前订单 BOM;'append' 直接追加(不去重)。权限仅登录(与其他录入一致)。
 */
export async function copyBomFromOrder(
  currentOrderId: string, sourceOrderId: string, mode: 'append' | 'replace' = 'append',
): Promise<{ count?: number; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  { const _bomErr = await requireRoleGroup(supabase, user.id, 'CAN_EDIT_BOM', '仅业务/采购/管理员可增删改物料清单(BOM)'); if (_bomErr) return { error: _bomErr }; }
  if (!sourceOrderId || sourceOrderId === currentOrderId) return { error: '请选择有效的历史订单' };

  // 服务端读 source BOM(只取要复制的列)
  const { data: src, error: sErr } = await (supabase.from('materials_bom') as any)
    .select('material_master_id, material_name, material_type, material_code, qty_per_piece, unit, supplier, placement, color, spec, notes, special_requirements')
    .eq('order_id', sourceOrderId);
  if (sErr) return { error: sErr.message };
  if (!src || src.length === 0) return { error: '该历史订单没有原辅料行可复制' };

  if (mode === 'replace') {
    const { error: dErr } = await (supabase.from('materials_bom') as any).delete().eq('order_id', currentOrderId);
    if (dErr) return { error: `清空当前 BOM 失败:${dErr.message}` };
  }

  const rows = src.map((r: any) => ({
    order_id: currentOrderId, created_by: user.id,
    material_master_id: r.material_master_id ?? null,
    material_name: r.material_name,
    material_type: r.material_type || 'other',
    material_code: r.material_code ?? null,
    qty_per_piece: r.qty_per_piece ?? null,
    unit: r.unit || 'meter',
    supplier: r.supplier ?? null,
    placement: r.placement ?? null,
    color: r.color ?? null,
    spec: r.spec ?? null,
    notes: r.notes ?? null,
    special_requirements: r.special_requirements ?? null,
    // 不复制:total_qty / submit_status / submitted_at / submitted_by / sample_given;version 默认 1
  }));
  const { error: iErr } = await (supabase.from('materials_bom') as any).insert(rows);
  if (iErr) return { error: `复制失败:${iErr.message}` };

  revalidatePath(`/orders/${currentOrderId}`);
  return { count: rows.length };
}

/**
 * Product Phase 2A:从订单行绑定的 Product Variant → Product → active Definition → BOM Template
 * 实例化进 materials_bom(写 product_bom_template_id + source='template')。
 * 单向、手动、不自动重算;不接 P1′、不改 B1、不改 product_bom_templates(只读)。
 * 大货单耗(production_consumption)不写入 —— 留 2B 带入采购;materials_bom 用开发单耗作 qty_per_piece(与 O1 一致)。
 */
export async function instantiateOrderMaterialPackage(
  orderId: string, mode: 'append' | 'replace' = 'append',
): Promise<{ ok?: boolean; count?: number; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  { const _bomErr = await requireRoleGroup(supabase, user.id, 'CAN_EDIT_BOM', '仅业务/采购/管理员可增删改物料清单(BOM)'); if (_bomErr) return { error: _bomErr }; }

  // 1) 订单行绑定的 Variant
  const { data: lines } = await (supabase.from('order_line_items') as any)
    .select('product_variant_id').eq('order_id', orderId);
  const variantIds = Array.from(new Set((lines || []).map((l: any) => l.product_variant_id).filter(Boolean)));
  if (variantIds.length === 0) return { error: '订单行未关联 Product Variant,请先在「🧬 产品款」Tab 关联' };

  // 2) Variant → Product
  const { data: variants } = await (supabase.from('product_variants') as any).select('id, product_id').in('id', variantIds);
  const productIds = Array.from(new Set((variants || []).map((v: any) => v.product_id).filter(Boolean)));
  if (productIds.length === 0) return { error: '变体无对应产品款' };

  // 3) Product → active(否则最新版本)Definition
  const { data: defs } = await (supabase.from('product_definitions') as any)
    .select('id, product_id, version, status').in('product_id', productIds);
  const defByProduct = new Map<string, any>();
  for (const d of (defs || [])) {
    const cur = defByProduct.get(d.product_id);
    const better = !cur || (d.status === 'active' && cur.status !== 'active')
      || (d.status === cur.status && (d.version || 0) > (cur.version || 0));
    if (better) defByProduct.set(d.product_id, d);
  }
  const defIds = Array.from(new Set([...defByProduct.values()].map((d: any) => d.id)));
  if (defIds.length === 0) return { error: '产品款暂无 Definition' };

  // 4) Definition → BOM Template
  const { data: tpls } = await (supabase.from('product_bom_templates') as any).select('*').in('definition_id', defIds);
  if (!tpls || tpls.length === 0) return { error: '关联产品款的 BOM Template 为空,请先在产品款库录入' };

  // 5) replace 先清当前订单 BOM;append 去重(同模板行已实例化跳过)
  if (mode === 'replace') {
    const { error: dErr } = await (supabase.from('materials_bom') as any).delete().eq('order_id', orderId);
    if (dErr) return { error: `清空失败:${dErr.message}` };
  }
  const { data: existing } = await (supabase.from('materials_bom') as any)
    .select('product_bom_template_id').eq('order_id', orderId);
  const seen = new Set<string>((existing || []).map((e: any) => e.product_bom_template_id).filter(Boolean));

  const rows = (tpls as any[]).filter(t => !seen.has(t.id)).map(t => ({
    order_id: orderId, created_by: user.id,
    material_master_id: t.material_master_id || null,
    material_name: t.material_name,
    material_type: t.category || 'other',                 // 模板采购分类 → materials_bom.material_type(10 值含之)
    qty_per_piece: t.development_consumption ?? null,       // 开发单耗(大货单耗留 2B 带入采购)
    unit: t.unit || 'meter',
    color: t.default_color || null,
    placement: t.default_placement || null,
    special_requirements: t.special_requirements || null,
    product_bom_template_id: t.id,
    source: 'template',
  }));
  if (rows.length === 0) return { ok: true, count: 0 };

  const { error } = await (supabase.from('materials_bom') as any).insert(rows);
  if (error) return { error: error.message };
  revalidatePath(`/orders/${orderId}`);
  return { ok: true, count: rows.length };
}

export async function updateBomItem(id: string, orderId: string, patch: Record<string, any>) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  { const _bomErr = await requireRoleGroup(supabase, user.id, 'CAN_EDIT_BOM', '仅业务/采购/管理员可增删改物料清单(BOM)'); if (_bomErr) return { error: _bomErr }; }

  // 该行来自产品款模板(有 product_bom_template_id)→ 编辑即记 Override 留痕(单向,不回写模板)
  const { data: row } = await (supabase.from('materials_bom') as any)
    .select('product_bom_template_id').eq('id', id).single();
  const upd: any = { ...patch, updated_at: new Date().toISOString() };
  if ((row as any)?.product_bom_template_id) {
    upd.overridden_at = new Date().toISOString();
    upd.overridden_by = user.id;
    // override_reason:patch 带了就写(BomTab 编辑模板行的可选输入)
  }

  const { error } = await (supabase.from('materials_bom') as any).update(upd).eq('id', id);
  if (error) return { error: error.message };
  revalidatePath(`/orders/${orderId}`);
  return {};
}

export async function deleteBomItem(id: string, orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  { const _bomErr = await requireRoleGroup(supabase, user.id, 'CAN_EDIT_BOM', '仅业务/采购/管理员可增删改物料清单(BOM)'); if (_bomErr) return { error: _bomErr }; }

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
  { const _bomErr = await requireRoleGroup(supabase, user.id, 'CAN_EDIT_BOM', '仅业务/采购/管理员可增删改物料清单(BOM)'); if (_bomErr) return { error: _bomErr }; }

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
): Promise<{ ok?: boolean; count?: number; error?: string; plan_id?: string; snapshot_version?: number; requirement_count?: number; missing_consumption?: string[] }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  { const _bomErr = await requireRoleGroup(supabase, user.id, 'CAN_EDIT_BOM', '仅业务/采购/管理员可增删改物料清单(BOM)'); if (_bomErr) return { error: _bomErr }; }

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

  // live BOM(完整列,用于冻结快照;style_no 用于 R1 按款算需求)
  const { data: bomRows, error: bomErr } = await (supabase.from('materials_bom') as any)
    .select('id, material_name, material_type, material_code, qty_per_piece, unit, color, placement, spec, supplier, style_no, pack_size, total_qty')
    .eq('order_id', orderId);
  // 业务手填的总需量(2026-07-08 用户拍板:辅料/打包件"不要自动算,按业务填的来")→ 覆盖 MRP 自动算
  const manualTotalByBom = new Map<string, number>();
  for (const b of (bomRows || [])) { const t = Number((b as any).total_qty); if (t > 0) manualTotalByBom.set((b as any).id, t); }
  if (bomErr) return { error: bomErr.message };
  if (!bomRows || bomRows.length === 0) return { error: '原辅料单为空,请先录入物料再提交' };

  // R1(2026-07-02 审计):款级 BOM 行(style_no 非空)按该款件数算需求,不能用整单数量
  // 2026-07-03:带颜色的行再往下钻一层 —— 按 款×色 件数算(布料按色下单,一色一数)
  const { data: liRows } = await (supabase.from('order_line_items') as any)
    .select('style_no, color_cn, color_en, qty_pcs, set_multiplier').eq('order_id', orderId);
  const styleQty = new Map<string, number>();
  const styleColorQty = new Map<string, number>();      // key: style¦规范色 → 该款该色件数
  const colorAlias = new Map<string, string>();          // style¦任一色名(中/英) → 规范色 key
  const normColor = (s: any) => String(s ?? '').trim().toLowerCase();
  for (const r of (liRows || []) as any[]) {
    if (!r.style_no) continue;
    // 套装:真实件数 = 件数 × 每套件数(set_multiplier;1=非套装),与 getBomItems 同口径,否则少采购
    const q = (Number(r.qty_pcs) || 0) * (Number(r.set_multiplier) > 0 ? Number(r.set_multiplier) : 1);
    styleQty.set(r.style_no, (styleQty.get(r.style_no) || 0) + q);
    // 2026-07-04 审计修:件数每行只加一次(原来 color_cn/color_en 各加一次,同名色翻倍→多算料)。
    // 规范色=中文优先,英文兜底;中英文两个色名都做别名指向同一桶,BOM 用任一色名可命中。
    const canon = normColor(r.color_cn) || normColor(r.color_en);
    if (!canon) continue;
    const canonKey = `${r.style_no}¦${canon}`;
    styleColorQty.set(canonKey, (styleColorQty.get(canonKey) || 0) + q);
    for (const c of [r.color_cn, r.color_en]) {
      const nc = normColor(c);
      if (nc) colorAlias.set(`${r.style_no}¦${nc}`, canonKey);
    }
  }
  const bomStyle = new Map<string, string | null>((bomRows as any[]).map(r => [r.id, r.style_no || null]));

  // R2(2026-07-02 审计):缺单耗的行生成不了需求量,显式警示而不是静默吞掉
  const missingConsumption = (bomRows as any[])
    .filter(r => r.qty_per_piece == null || Number(r.qty_per_piece) <= 0)
    .map(r => r.material_name);

  // 损耗率 + 报价基线行(来自成本基线,缺损耗则默认 3)
  const { data: baseline } = await (supabase.from('order_cost_baseline') as any)
    .select('waste_pct, quote_baseline_lines').eq('order_id', orderId).maybeSingle();
  const waste_pct = (baseline as any)?.waste_pct ?? 3;

  // ── 内控闸:超报价基线单耗不许提交(2026-07-06 用户拍板;报价基线=从内部报价单冻结、人已确认)──
  // 逐料把 BOM 单耗 vs 报价基线单耗比对,超 5% → 拦(疑似抛量);要提量请先在「报价基线」调整并冻结(报价变更),
  // 或核减 BOM 单耗。只对"基线里有的料"比对(名字对不上的不误拦)。
  const baseLinesForGate: any[] = (baseline as any)?.quote_baseline_lines || [];
  {
    const normN = (s: any) => String(s ?? '').trim().toLowerCase();
    const baseCons = new Map<string, number>();
    for (const b of baseLinesForGate) {
      const k = normN(b.material_name); const c = Number(b.quote_consumption) || 0;
      if (k && c > 0) baseCons.set(k, Math.max(baseCons.get(k) || 0, c));
    }
    // 口径(2026-07-06 用户拍板):单耗只要超基线(>0%)→ 拦,报业务执行经理批;超 5% → +财务批。批过才放行。
    const overLines: { material: string; bom_cons: number; base_cons: number; over_pct: number }[] = [];
    for (const r of bomRows as any[]) {
      const qpp = Number(r.qty_per_piece) || 0;
      const base = baseCons.get(normN(r.material_name));
      if (base && qpp > base) {
        overLines.push({ material: r.material_name, bom_cons: qpp, base_cons: base, over_pct: Math.round((qpp / base - 1) * 1000) / 10 });
      }
    }
    if (overLines.length > 0) {
      const { ensureBudgetApproval } = await import('@/app/actions/budget-approvals');
      const gate = await ensureBudgetApproval(createServiceRoleClient(), orderId, user.id, overLines);
      if (!gate.ok) return { error: gate.message };   // 未获所需审批 → 拦下(已挂起审批单)
    } else if (baseLinesForGate.length === 0 && process.env.PROCUREMENT_REQUIRE_BASELINE === 'on') {
      // 无报价基线 → 默认放行(不破坏存量在途单);env 打开则强制"先录基线才能提交"
      return { error: '该单未录报价基线,不能提交采购。请先在「报价基线」页上传内部报价单、核对后冻结基线,再来提交。' };
    }
  }

  // ── 必传闸(2026-07-06 用户拍板):不传技术部大货确认单,不许提交采购 ──
  {
    const { hasTechConfirm } = await import('@/app/actions/tech-confirm');
    if (!(await hasTechConfirm(orderId))) {
      return { error: '请先在「原辅料和包装」页(大货单耗表旁)上传技术部签名的大货确认单,再提交采购。' };
    }
  }

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
      pack_size: r.pack_size ?? null,   // 每包件数(打包辅料;冻结带过去,MRP 需求÷每包件数)
      suggested_supplier: r.supplier, sample_status: null, remarks: null,
    }));
    let { error: lineErr } = await (supabase.from('material_package_snapshot_lines') as any).insert(lineRows);
    if (lineErr && /pack_size|column .* does not exist/i.test(lineErr.message || '')) {
      // pack_size 迁移(20260707)未执行 → 降级去列重插(不 brick 提交),提醒执行迁移
      const plain = lineRows.map(({ pack_size, ...rest }) => rest);
      ({ error: lineErr } = await (supabase.from('material_package_snapshot_lines') as any).insert(plain));
    }
    if (lineErr) return { error: `快照行创建失败:${lineErr.message}` };
  }

  // ── 内控闸(2026-07-06 用户强调:业务不能反复整单重提采购)──
  // 采购已把本单归并/下过采购单后,业务又改了原辅料(!reuseSnap=BOM 变了)→ 禁止整单"重新提交采购",
  // 否则新需求与已下采购单错位/重复采购。BOM 未变的重提(reuseSnap)是幂等、放行。
  // 需改料 → 通知采购在采购侧对相应行增删(增量改),不走整单重提。
  if (!reuseSnap) {
    const { data: placedLines } = await (supabase.from('procurement_line_items') as any)
      .select('id, purchase_order_id').eq('order_id', orderId).not('purchase_order_id', 'is', null).limit(1);
    if ((placedLines || []).length > 0) {
      return { error: '采购已就本单归并/下采购单,而原辅料又有改动 → 不能整单「重新提交采购」(会与已下采购单错位或重复采购)。如需改料,请通知采购在采购侧对相应行做增删(增量修改),不要整单重提。' };
    }
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
  // 保险丝(2026-07-03):表缺 DELETE 策略时删除会静默 0 行 → 重新提交采购需求翻倍。
  // 先数旧行,删不掉就中止 —— 宁可报错,绝不叠加。
  const { count: oldReqCount } = await (supabase.from('material_requirements') as any)
    .select('id', { count: 'exact', head: true }).eq('material_plan_id', planId);
  const { data: delReqs, error: delReqErr } = await (supabase.from('material_requirements') as any)
    .delete().eq('material_plan_id', planId).select('id');
  if (delReqErr) return { error: `旧需求清理失败,已中止(避免需求叠加):${delReqErr.message}` };
  if ((oldReqCount || 0) > 0 && (delReqs || []).length === 0) {
    return { error: '提交中止:旧物料需求删不掉(数据库缺 DELETE 权限,会导致需求翻倍)。请先在 Supabase 执行 20260703_delete_policies_fix.sql' };
  }
  // P0:快照行查询失败必须抛,不静默零需求(CLAUDE.md 血泪教训)。
  const { data: snapLines, error: snapErr } = await (supabase.from('material_package_snapshot_lines') as any)
    .select('*').eq('snapshot_id', snapshotId!);
  if (snapErr) return { error: `快照行读取失败,已中止(避免零需求):${snapErr.message}` };
  const today = toYmd(new Date());
  // ── MRP 扣库存(flag MRP_INVENTORY_DEDUCT 默认关)。开 → 喂真 available=onHand−reserved(SC-P2 预留感知);关 → 0(现状不变)。──
  const deductInv = process.env.MRP_INVENTORY_DEDUCT === 'on';
  const balByKey = new Map<string, number>();
  const resByKey = new Map<string, number>();
  const bomMaster = new Map<string, string | null>(); // bom_id → material_master_id(key 派生须与 procurement_items 一致)
  if (deductInv) {
    const { data: invTxns, error: invErr } = await (supabase.from('inventory_transactions') as any).select('material_key, qty');
    if (invErr) console.warn('[MRP扣库存] 库存读取失败,保守按 0(宁多勿缺):', invErr.message);
    for (const b of aggregateInventoryBalance((invTxns || []) as any[])) balByKey.set(b.material_key, b.on_hand);
    const { data: resv, error: resvErr } = await (supabase.from('inventory_reservation') as any)
      .select('material_key, qty, status').eq('status', 'reserved');
    if (resvErr) console.warn('[MRP扣库存] 预留读取失败:', resvErr.message);
    for (const [k, v] of reservedByKey((resv || []) as any[])) resByKey.set(k, v);
    // P0:解析 master_id,使扣库存 key 与 procurement_items/库存同口径(含 color+master),否则彩色物料 key 永远对不上→available 误读 0。
    const bomIds = Array.from(new Set((snapLines || []).map((l: any) => l.bom_id).filter(Boolean)));
    if (bomIds.length) {
      const { data: bs } = await (supabase.from('materials_bom') as any).select('id, material_master_id').in('id', bomIds);
      for (const b of (bs || [])) bomMaster.set(b.id, b.material_master_id);
    }
  }
  const reqRows = (snapLines || []).map((line: any) => {
    // flag 开:规范 key(master_id + color + 名/规/类/单位,与 procurement_items/库存同口径)→ available=onHand−reserved,负钳 0。关:0。
    let inventoryQty = 0;
    if (deductInv) {
      const key = consolidationKey({
        material_master_id: line.bom_id ? (bomMaster.get(line.bom_id) || null) : null,
        material_name: line.material_name, specification: line.specification,
        category: line.category, color: line.color, unit: line.unit,
      });
      inventoryQty = Math.max(0, (balByKey.get(key) || 0) - (resByKey.get(key) || 0));
    }
    // R1:款级行用该款件数(明细未录该款时兜底整单数量,宁多勿缺);整单通用行用整单数量
    // 2026-07-03:行带颜色且明细里有该 款×色 → 用该色件数(布料一色一数,不再全款重复算)
    const lineStyle = line.bom_id ? bomStyle.get(line.bom_id) : null;
    let poQty = (lineStyle && styleQty.get(lineStyle)) ? styleQty.get(lineStyle)! : order.quantity;
    if (lineStyle && String(line.color ?? '').trim()) {
      // 别名解析:BOM 色名(中或英)→ 规范色桶,再取件数(不再因中英文写法漏命中/翻倍)
      const bk = `${lineStyle}¦${normColor(line.color)}`;
      const cq = styleColorQty.get(colorAlias.get(bk) || bk);
      if (cq && cq > 0) poQty = cq;
      // 色名对不上明细 → 保持款级总量(宁多勿缺),核料里人工调
    }
    const r = computeMaterialRequirement({
      material: {
        material_name: line.material_name, material_type: line.material_type,
        material_code: line.material_code, unit: line.unit,
        qty_per_piece: line.qty_per_piece, loss_rate: line.loss_rate,
        pack_size: line.pack_size,   // 每包件数 → MRP 需求÷每包件数(中包袋6件一中包→6)
      },
      po_quantity: poQty, stageAnchors, inventoryQty, reuseQty: 0, today,
    });
    // 业务手填总需量 → 直接以人工为准(不自动算;中包袋/打包件等)。填了就用。
    // 没填时:辅料(非面料/里料)缺单耗 → 兜底=件数(不再算成 0/needs_input);面料仍需大货单耗,保持原样。
    const manualTotal = line.bom_id ? manualTotalByBom.get(line.bom_id) : undefined;
    const isTrimLike = line.material_type !== 'fabric' && line.material_type !== 'lining';
    const netFinal = (manualTotal != null && manualTotal > 0) ? manualTotal
      : (r.net_purchase_qty != null && r.net_purchase_qty > 0) ? r.net_purchase_qty
      : (isTrimLike ? poQty : r.net_purchase_qty);
    return {
      material_plan_id: planId, order_id: orderId, snapshot_line_id: line.id,
      material_name: r.material_name, material_type: r.material_type, category: r.category,
      material_code: r.material_code, unit: r.unit,
      pieces_qty: poQty,   // 件数基数(款×色):归并层按款精确乘大货单耗用
      gross_requirement: manualTotal != null && manualTotal > 0 ? manualTotal : r.gross_requirement, loss_qty: r.loss_qty,
      inventory_deduct: r.inventory_deduct, reuse_deduct: r.reuse_deduct, net_purchase_qty: netFinal,
      required_stage: r.required_stage, required_date: r.required_date,
      supplier_lead_days: r.supplier_lead_days, order_by_date: r.order_by_date, timing_status: r.timing_status,
      explain_json: r.explain_json, status: r.status === 'needs_input' ? 'open' : r.status,
      last_recomputed_at: now,
    };
  });
  if (reqRows.length > 0) {
    let { error: reqErr } = await (supabase.from('material_requirements') as any).insert(reqRows);
    if (reqErr && /pieces_qty|column .* does not exist/i.test(reqErr.message || '')) {
      // 件数基数列迁移未执行 → 降级插入(归并将退回按净需求推算),提醒执行迁移
      console.warn('[submitBom] pieces_qty 列缺失,降级插入。请执行 20260703_per_style_production_consumption.sql');
      const plain = reqRows.map(({ pieces_qty, ...rest }: any) => rest);
      ({ error: reqErr } = await (supabase.from('material_requirements') as any).insert(plain));
    }
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
  return { ok: true, count: bomRows.length, plan_id: planId, snapshot_version: snapshotVersion!, requirement_count: reqRows.length, missing_consumption: missingConsumption };
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
  { const _bomErr = await requireRoleGroup(supabase, user.id, 'CAN_EDIT_BOM', '仅业务/采购/管理员可增删改物料清单(BOM)'); if (_bomErr) return { error: _bomErr }; }
  const { error } = await (supabase.from('materials_bom') as any)
    .update({ sample_given: given }).eq('id', id).eq('order_id', orderId);
  if (error) return { error: error.message };
  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}
