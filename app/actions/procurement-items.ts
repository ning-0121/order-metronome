'use server';

/**
 * Procurement Item(采购核料项)—— P1′。
 * 同订单内按 物料身份+颜色+单位 自动归并 material_requirements → 采购确认 → 生命周期。
 * Constitution 02(需求量 live 引用不复制)/ 03(生命周期)/ 04(本表=采购层)。
 * 红线:不改 O1/O2/B1/material_requirements/procurement_line_items/现有采购中心;只读 join 引用上游;不接 AI。
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { friendlyError } from '@/lib/utils/db-error';
import { consolidationKey, computeSuggestedPurchaseQty, type IdentityInput } from '@/lib/services/procurement-consolidation';

const num = (v: any) => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));

/** 列出某订单的采购核料项。 */
export async function listProcurementItems(orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data, error } = await (supabase.from('procurement_items') as any)
    .select('*').eq('order_id', orderId).order('item_no');
  if (error) return { error: friendlyError(error) };
  return { data: data || [] };
}

/**
 * 核料归并:读 material_requirements ⋈ snapshot_lines ⋈ materials_bom → 按 key 分组 → upsert 采购项。
 * 分步查询 + JS join(避开深层 PostgREST 嵌套 join 脆弱)。保留采购已填决策,仅刷新系统字段。
 */
export async function consolidateOrderProcurementItems(orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: order } = await (supabase.from('orders') as any).select('order_no').eq('id', orderId).single();
  const orderNo = (order as any)?.order_no || orderId.slice(0, 8);

  // 1) 需求
  const { data: reqs, error: rErr } = await (supabase.from('material_requirements') as any)
    .select('id, snapshot_line_id, material_name, material_code, category, unit, net_purchase_qty, version')
    .eq('order_id', orderId);
  if (rErr) return { error: friendlyError(rErr) };
  if (!reqs || reqs.length === 0) return { error: '该订单暂无物料需求(请先在「原辅料和包装」提交采购,跑出 MRP)' };

  // 2) snapshot_lines(color/spec/开发单耗/bom_id)
  const slIds = Array.from(new Set(reqs.map((r: any) => r.snapshot_line_id).filter(Boolean)));
  const slMap = new Map<string, any>();
  if (slIds.length) {
    const { data: sls } = await (supabase.from('material_package_snapshot_lines') as any)
      .select('id, color, specification, qty_per_piece, bom_id, material_name').in('id', slIds);
    for (const s of (sls || [])) slMap.set(s.id, s);
  }
  // 3) materials_bom（master_id）
  const bomIds = Array.from(new Set([...slMap.values()].map((s: any) => s.bom_id).filter(Boolean)));
  const bomMaster = new Map<string, string | null>();
  if (bomIds.length) {
    const { data: bs } = await (supabase.from('materials_bom') as any).select('id, material_master_id').in('id', bomIds);
    for (const b of (bs || [])) bomMaster.set(b.id, b.material_master_id);
  }

  // 4) 按 key 分组
  const groups = new Map<string, any>();
  for (const r of reqs) {
    const sl = r.snapshot_line_id ? slMap.get(r.snapshot_line_id) : null;
    const master_id = sl?.bom_id ? (bomMaster.get(sl.bom_id) || null) : null;
    const identity: IdentityInput = {
      material_master_id: master_id,
      material_name: r.material_name || sl?.material_name || null,
      specification: sl?.specification || null,
      category: r.category || null,
      color: sl?.color || null,
      unit: r.unit || null,
    };
    const key = consolidationKey(identity);
    const net = Number(r.net_purchase_qty) || 0;
    const dev = sl?.qty_per_piece != null ? Number(sl.qty_per_piece) : null;
    let g = groups.get(key);
    if (!g) { g = { key, ...identity, total: 0, count: 0, devTop: null, devTopNet: -1 }; groups.set(key, g); }
    g.total += net; g.count += 1;
    if (net > g.devTopNet) { g.devTopNet = net; g.devTop = dev; }   // 主导来源的开发单耗作代表值
  }

  // 5) 现有采购项
  const { data: existing } = await (supabase.from('procurement_items') as any)
    .select('id, consolidation_key, status, total_required_qty, production_consumption, development_consumption, procurement_loss_pct, safety_stock_qty, moq')
    .eq('order_id', orderId);
  const exMap = new Map<string, any>((existing || []).map((e: any) => [e.consolidation_key, e]));

  let created = 0, updated = 0, flagged = 0;
  let seq = (existing || []).length;
  const now = new Date().toISOString();

  for (const g of groups.values()) {
    const ex = exMap.get(g.key);
    if (ex) {
      const devRep = ex.development_consumption ?? g.devTop;
      const suggested = computeSuggestedPurchaseQty({
        total_required_qty: g.total, development_consumption: devRep,
        production_consumption: ex.production_consumption, procurement_loss_pct: ex.procurement_loss_pct,
        safety_stock_qty: ex.safety_stock_qty, moq: ex.moq,
      });
      const upd: any = {
        total_required_qty: g.total, source_count: g.count, development_consumption: devRep,
        suggested_purchase_qty: suggested, updated_at: now,
      };
      if (Number(ex.total_required_qty) !== g.total && ex.status !== 'draft') { upd.needs_reconfirm = true; flagged++; }
      await (supabase.from('procurement_items') as any).update(upd).eq('id', ex.id);
      updated++;
    } else {
      seq++;
      const suggested = computeSuggestedPurchaseQty({ total_required_qty: g.total, development_consumption: g.devTop });
      const { error: iErr } = await (supabase.from('procurement_items') as any).insert({
        order_id: orderId, consolidation_key: g.key,
        item_no: `PI-${orderNo}-${String(seq).padStart(3, '0')}`,
        material_master_id: g.material_master_id, material_name: g.material_name, specification: g.specification,
        category: g.category, color: g.color, unit: g.unit,
        total_required_qty: g.total, source_count: g.count, development_consumption: g.devTop,
        suggested_purchase_qty: suggested, status: 'draft', created_by: user.id,
      });
      if (iErr) return { error: friendlyError(iErr) };
      created++;
    }
  }

  // 6) 旧项不再有来源(物料被删/改) → needs_reconfirm
  const liveKeys = new Set(groups.keys());
  for (const e of (existing || [])) {
    if (!liveKeys.has(e.consolidation_key) && e.status !== 'draft') {
      await (supabase.from('procurement_items') as any).update({ needs_reconfirm: true, updated_at: now }).eq('id', e.id);
      flagged++;
    }
  }

  revalidatePath(`/orders/${orderId}`);
  return { ok: true, created, updated, flagged, total_items: groups.size };
}

/** 来源明细(live):该采购项归并键命中的 requirements ⋈ snapshot_lines。粒度=物料行(产品维度缺口见 P1.md §5.1)。 */
export async function getProcurementItemSources(itemId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: item } = await (supabase.from('procurement_items') as any)
    .select('order_id, consolidation_key').eq('id', itemId).single();
  if (!item) return { error: '采购项不存在' };

  const { data: reqs } = await (supabase.from('material_requirements') as any)
    .select('id, snapshot_line_id, material_name, category, unit, net_purchase_qty')
    .eq('order_id', (item as any).order_id);
  const slIds = Array.from(new Set((reqs || []).map((r: any) => r.snapshot_line_id).filter(Boolean)));
  const slMap = new Map<string, any>();
  if (slIds.length) {
    const { data: sls } = await (supabase.from('material_package_snapshot_lines') as any)
      .select('id, color, specification, qty_per_piece, bom_id, material_name').in('id', slIds);
    for (const s of (sls || [])) slMap.set(s.id, s);
  }
  const bomIds = Array.from(new Set([...slMap.values()].map((s: any) => s.bom_id).filter(Boolean)));
  const bomMaster = new Map<string, string | null>();
  if (bomIds.length) {
    const { data: bs } = await (supabase.from('materials_bom') as any).select('id, material_master_id').in('id', bomIds);
    for (const b of (bs || [])) bomMaster.set(b.id, b.material_master_id);
  }

  const sources = (reqs || []).map((r: any) => {
    const sl = r.snapshot_line_id ? slMap.get(r.snapshot_line_id) : null;
    const master_id = sl?.bom_id ? (bomMaster.get(sl.bom_id) || null) : null;
    const key = consolidationKey({
      material_master_id: master_id, material_name: r.material_name || sl?.material_name,
      specification: sl?.specification, category: r.category, color: sl?.color, unit: r.unit,
    });
    return { key, material_name: r.material_name || sl?.material_name, color: sl?.color || null,
      development_consumption: sl?.qty_per_piece ?? null, net_demand: r.net_purchase_qty ?? null };
  }).filter((s: any) => s.key === (item as any).consolidation_key);

  return { data: sources };
}

/** 采购确认:填大货单耗/损耗/安全库存/MOQ/供应商/价/决策,重算 suggested。 */
export async function updateProcurementItem(itemId: string, orderId: string, fields: Record<string, any>) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: item } = await (supabase.from('procurement_items') as any)
    .select('total_required_qty, development_consumption').eq('id', itemId).single();
  if (!item) return { error: '采购项不存在' };

  const numFields = ['production_consumption', 'procurement_loss_pct', 'safety_stock_qty', 'final_purchase_qty', 'lead_days', 'moq', 'unit_price', 'tax_rate'];
  const boolFields = ['is_substitute', 'is_split', 'is_outsourced', 'risk_flag', 'price_inclusive_tax'];
  const textFields = ['confirmed_supplier_name', 'backup_supplier_name', 'supplier_contact', 'purchase_unit', 'currency', 'substitute_reason', 'risk_note', 'procurement_notes'];

  const upd: any = { updated_at: new Date().toISOString() };
  for (const k of numFields) if (k in fields) upd[k] = num(fields[k]);
  for (const k of boolFields) if (k in fields) upd[k] = !!fields[k];
  for (const k of textFields) if (k in fields) upd[k] = fields[k] || null;
  if ('quote_date' in fields) upd.quote_date = fields.quote_date || null;

  // 重算 suggested(用新输入)
  upd.suggested_purchase_qty = computeSuggestedPurchaseQty({
    total_required_qty: (item as any).total_required_qty,
    development_consumption: (item as any).development_consumption,
    production_consumption: upd.production_consumption ?? undefined,
    procurement_loss_pct: upd.procurement_loss_pct ?? undefined,
    safety_stock_qty: upd.safety_stock_qty ?? undefined,
    moq: upd.moq ?? undefined,
  });

  const { error } = await (supabase.from('procurement_items') as any).update(upd).eq('id', itemId);
  if (error) return { error: friendlyError(error) };
  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}

/** 生命周期推进。confirmed→记确认留痕 + 来源版本快照 + 清 needs_reconfirm。 */
export async function updateProcurementItemStatus(itemId: string, orderId: string, status: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const VALID = ['draft', 'reviewing', 'confirmed', 'ordered', 'partially_received', 'completed', 'closed'];
  if (!VALID.includes(status)) return { error: '非法状态' };

  const now = new Date().toISOString();
  const upd: any = { status, updated_at: now };
  if (status === 'confirmed') {
    upd.confirmed_by = user.id; upd.confirmed_at = now; upd.needs_reconfirm = false;
    // 来源快照(审计/判过期)
    const src = await getProcurementItemSources(itemId);
    if ((src as any).data) upd.confirmed_source_snapshot = (src as any).data;
  }
  const { error } = await (supabase.from('procurement_items') as any).update(upd).eq('id', itemId);
  if (error) return { error: friendlyError(error) };
  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}
