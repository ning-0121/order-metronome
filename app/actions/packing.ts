'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

export async function getPackingLists(orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: null, error: '请先登录' };
  const { data, error } = await (supabase.from('packing_lists') as any)
    .select('*, packing_list_lines(*)').eq('order_id', orderId)
    .order('created_at', { ascending: false });
  if (error) return { data: null, error: error.message };
  return { data, error: null };
}

export async function addPackingList(orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: null, error: '请先登录' };

  const plNumber = `PL-${Date.now().toString(36).toUpperCase()}`;
  const { data, error } = await (supabase.from('packing_lists') as any)
    .insert({ order_id: orderId, created_by: user.id, pl_number: plNumber, status: 'draft' })
    .select('id').single();
  if (error) return { data: null, error: error.message };
  revalidatePath(`/orders/${orderId}`);
  return { data, error: null };
}

export async function addPackingLine(packingListId: string, orderId: string, line: {
  style_no?: string; color?: string; carton_count: number;
  qty_per_carton: number;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const totalQty = (line.carton_count || 0) * (line.qty_per_carton || 0);
  const { error } = await (supabase.from('packing_list_lines') as any).insert({
    packing_list_id: packingListId, order_id: orderId,
    style_no: line.style_no || null, color: line.color || null,
    carton_count: line.carton_count, qty_per_carton: line.qty_per_carton,
    total_qty: totalQty,
  });
  if (error) return { error: error.message };

  // 更新装箱单合计
  const { data: lines } = await (supabase.from('packing_list_lines') as any)
    .select('carton_count, total_qty').eq('packing_list_id', packingListId);
  const totalCartons = (lines || []).reduce((s: number, l: any) => s + (l.carton_count || 0), 0);
  const totalPcs = (lines || []).reduce((s: number, l: any) => s + (l.total_qty || 0), 0);
  await (supabase.from('packing_lists') as any)
    .update({ total_cartons: totalCartons, total_qty: totalPcs }).eq('id', packingListId);

  revalidatePath(`/orders/${orderId}`);
  return {};
}

export async function deletePackingLine(lineId: string, packingListId: string, orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { error } = await (supabase.from('packing_list_lines') as any).delete().eq('id', lineId);
  if (error) return { error: error.message };

  // 更新合计
  const { data: lines } = await (supabase.from('packing_list_lines') as any)
    .select('carton_count, total_qty').eq('packing_list_id', packingListId);
  const totalCartons = (lines || []).reduce((s: number, l: any) => s + (l.carton_count || 0), 0);
  const totalPcs = (lines || []).reduce((s: number, l: any) => s + (l.total_qty || 0), 0);
  await (supabase.from('packing_lists') as any)
    .update({ total_cartons: totalCartons, total_qty: totalPcs }).eq('id', packingListId);

  revalidatePath(`/orders/${orderId}`);
  return {};
}

/**
 * 出货录入草稿:从 order_line_items(款×色×数量+成分/尺码)预填,叠加已存的实发装箱数据。
 * 返回订单头 + 该单唯一 draft 装箱单(不存则建) + 逐款×色行(供最后一道节点录实发数据)。
 * packing_list_lines 只存「出货事实」(每箱数/箱数/实发数/毛净重/箱规);成分/尺码/PO# 生成时回查主数据。
 */
export async function getShippingDraft(orderId: string, batchId?: string | null) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: order, error: oe } = await (supabase.from('orders') as any)
    .select('id, order_no, internal_order_no, po_number, customer_name, style_no, etd, incoterm, currency, quantity')
    .eq('id', orderId).maybeSingle();
  if (oe) return { error: oe.message };
  if (!order) return { error: '订单不存在' };

  // 主数据:款×色×数量 + 成分(fabric_name)+ 尺码(prefill 订单/批次数量,供对照实发)
  const { data: oli } = await (supabase.from('order_line_items') as any)
    .select('id, style_no, product_name, color_cn, color_en, sizes, qty_pcs, fabric_name')
    .eq('order_id', orderId).order('line_no', { ascending: true });

  // 分批:该批分配到各行的数量(order_line_item_id → qty_pcs);无 batchId 则整单
  const batchQtyByLine = new Map<string, number>();
  if (batchId) {
    const { data: sbi } = await (supabase.from('shipment_batch_items') as any)
      .select('order_line_item_id, qty_pcs').eq('batch_id', batchId);
    for (const it of (sbi || [])) batchQtyByLine.set(it.order_line_item_id, Number(it.qty_pcs) || 0);
  }

  // get-or-create 该批(或整单)的 draft 装箱单;分批时 batch_id 作用域隔离
  let plQ = (supabase.from('packing_lists') as any)
    .select('id, pl_number, status, doc_meta').eq('order_id', orderId).eq('status', 'draft');
  plQ = batchId ? plQ.eq('batch_id', batchId) : plQ.is('batch_id', null);
  let { data: pl } = await plQ.order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!pl) {
    // 新批装箱单:doc_meta 继承同单已有(币种/银行/报关字段填一次即传各批)
    const { data: sibling } = await (supabase.from('packing_lists') as any)
      .select('doc_meta').eq('order_id', orderId).not('doc_meta', 'is', null)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    const plNumber = `PL-${Date.now().toString(36).toUpperCase()}`;
    const { data: created, error: ce } = await (supabase.from('packing_lists') as any)
      .insert({ order_id: orderId, batch_id: batchId || null, created_by: user.id, pl_number: plNumber, status: 'draft', doc_meta: sibling?.doc_meta || null })
      .select('id, pl_number, status, doc_meta').single();
    if (ce) return { error: ce.message };
    pl = created;
  }
  // CI 页脚元数据(业务填):无则给默认;币种默认取订单币种
  const docMeta = { currency: order.currency || 'USD', ...(pl.doc_meta || {}) };

  const { data: existing } = await (supabase.from('packing_list_lines') as any)
    .select('*').eq('packing_list_id', pl.id).order('sequence_no', { ascending: true });
  const byKey = new Map<string, any>();
  for (const l of (existing || [])) byKey.set(`${l.style_no || ''}¦${l.color || ''}`, l);

  // 合并:每个「款×色」一行,带出订单数量,叠加已录实发装箱
  const rows: any[] = [];
  let seq = 1;
  for (const r of (oli || [])) {
    // 分批:只带该批分配到的行;订单量取该批分配量
    const orderQty = batchId ? (batchQtyByLine.get(r.id) || 0) : (Number(r.qty_pcs) || 0);
    if (batchId && orderQty <= 0) continue;
    const color = r.color_cn || r.color_en || '';
    const key = `${r.style_no || ''}¦${color}`;
    const ex = byKey.get(key);
    rows.push({
      style_no: r.style_no || '', color, product_name: r.product_name || '',
      composition: r.fabric_name || '', sizes: r.sizes || {},
      order_qty: orderQty,
      // 实发装箱(已录则回填,否则空待录)
      qty_per_carton: ex?.qty_per_carton ?? '', carton_count: ex?.carton_count ?? '',
      actual_qty: ex?.total_qty ?? (orderQty || ''),   // 默认=订单/批次量,可改
      net_weight_per_carton: ex?.net_weight_per_carton ?? '',
      gross_weight_per_carton: ex?.gross_weight_per_carton ?? '',
      dim_l: ex?.carton_dims_cm?.l ?? '', dim_w: ex?.carton_dims_cm?.w ?? '', dim_h: ex?.carton_dims_cm?.h ?? '',
      sequence_no: seq++,
    });
    byKey.delete(key);
  }
  // 主数据里没有、但已录过的行(手工加的)也带出来,不丢
  for (const ex of byKey.values()) {
    rows.push({
      style_no: ex.style_no || '', color: ex.color || '', product_name: '', composition: '', sizes: ex.size_breakdown || {},
      order_qty: 0, qty_per_carton: ex.qty_per_carton ?? '', carton_count: ex.carton_count ?? '',
      actual_qty: ex.total_qty ?? '', net_weight_per_carton: ex.net_weight_per_carton ?? '',
      gross_weight_per_carton: ex.gross_weight_per_carton ?? '',
      dim_l: ex.carton_dims_cm?.l ?? '', dim_w: ex.carton_dims_cm?.w ?? '', dim_h: ex.carton_dims_cm?.h ?? '',
      sequence_no: seq++,
    });
  }

  return { data: { order, packingListId: pl.id, plNumber: pl.pl_number, status: pl.status, rows, docMeta } };
}

/** 保存 CI 页脚/币种元数据(业务填:币种/定金/付款条件/运费/出厂日/银行信息)。 */
export async function saveShippingDocMeta(orderId: string, packingListId: string, meta: any) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { error } = await (supabase.from('packing_lists') as any)
    .update({ doc_meta: meta || {}, updated_at: new Date().toISOString() }).eq('id', packingListId);
  if (error) return { error: error.message };
  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}

/** 批量保存出货装箱行(replace 该装箱单全部行 + 重算合计)。lines 为 getShippingDraft 行形状。 */
export async function saveShippingLines(orderId: string, packingListId: string, lines: any[]) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const num = (v: any) => (v === '' || v == null ? null : Number(v));
  const clean = (lines || [])
    .filter(l => (l.style_no || l.color) && (num(l.actual_qty) || num(l.carton_count)))
    .map((l, i) => {
      const cartons = num(l.carton_count) || 0;
      const perCarton = num(l.qty_per_carton);
      // 实发数量优先取录入值;没录则 箱数×每箱数
      const totalQty = num(l.actual_qty) ?? (perCarton != null ? cartons * perCarton : 0);
      const dims = (num(l.dim_l) || num(l.dim_w) || num(l.dim_h))
        ? { l: num(l.dim_l), w: num(l.dim_w), h: num(l.dim_h) } : null;
      return {
        packing_list_id: packingListId, order_id: orderId,
        style_no: l.style_no || null, color: l.color || null,
        size_breakdown: l.sizes && typeof l.sizes === 'object' ? l.sizes : {},
        qty_per_carton: perCarton, carton_count: cartons, total_qty: totalQty || 0,
        net_weight_per_carton: num(l.net_weight_per_carton),
        gross_weight_per_carton: num(l.gross_weight_per_carton),
        carton_dims_cm: dims, sequence_no: i + 1,
      };
    });

  // replace
  const { error: de } = await (supabase.from('packing_list_lines') as any).delete().eq('packing_list_id', packingListId);
  if (de) return { error: de.message };
  if (clean.length) {
    const { error: ie } = await (supabase.from('packing_list_lines') as any).insert(clean);
    if (ie) return { error: ie.message };
  }

  // 重算装箱单合计
  const totalCartons = clean.reduce((s, l) => s + (l.carton_count || 0), 0);
  const totalPcs = clean.reduce((s, l) => s + (l.total_qty || 0), 0);
  const totalNet = clean.reduce((s, l) => s + (l.carton_count || 0) * (l.net_weight_per_carton || 0), 0);
  const totalGross = clean.reduce((s, l) => s + (l.carton_count || 0) * (l.gross_weight_per_carton || 0), 0);
  const totalVol = clean.reduce((s, l) => {
    const d = l.carton_dims_cm; if (!d?.l || !d?.w || !d?.h) return s;
    return s + (d.l * d.w * d.h) * (l.carton_count || 0) / 1_000_000;
  }, 0);
  await (supabase.from('packing_lists') as any).update({
    total_cartons: totalCartons, total_qty: totalPcs,
    total_net_weight: Math.round(totalNet * 100) / 100,
    total_gross_weight: Math.round(totalGross * 100) / 100,
    total_volume: Math.round(totalVol * 1000) / 1000,
    updated_at: new Date().toISOString(),
  }).eq('id', packingListId);

  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}

export async function confirmPackingList(id: string, orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { error } = await (supabase.from('packing_lists') as any)
    .update({ status: 'confirmed', confirmed_by: user.id, confirmed_at: new Date().toISOString() })
    .eq('id', id).eq('status', 'draft');
  if (error) return { error: error.message };
  revalidatePath(`/orders/${orderId}`);
  return {};
}
