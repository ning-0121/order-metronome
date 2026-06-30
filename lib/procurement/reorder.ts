// ============================================================
// Reorder (返单) payload generator — READ-ONLY，payload-only
// 输入: order_id → 输出结构化返单 payload（明细 + 数量）。
// 铁律: 绝不写库、绝不自动创建订单。供人工据此手动创建新返单。
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ReorderPayload, ReorderLine } from './types';

interface OrderHeadRow {
  id: string;
  order_no: string;
  customer_name: string;
  style_no: string | null;
}
interface LineRow {
  line_no: number | null;
  style_no: string | null;
  color_cn: string | null;
  color_en: string | null;
  sizes: Record<string, number> | null;
  qty_pcs: number | null;
}

export async function buildReorderPayload(
  supabase: SupabaseClient,
  orderId: string,
): Promise<ReorderPayload | null> {
  const { data: od } = await supabase
    .from('orders')
    .select('id, order_no, customer_name, style_no')
    .eq('id', orderId)
    .maybeSingle();
  const o = od as OrderHeadRow | null;
  if (!o) return null;

  const { data: lid } = await supabase
    .from('order_line_items')
    .select('line_no, style_no, color_cn, color_en, sizes, qty_pcs')
    .eq('order_id', orderId)
    .order('line_no');

  const line_items: ReorderLine[] = ((lid as LineRow[] | null) ?? []).map((l) => ({
    style_no: l.style_no ?? null,
    color: l.color_en ?? l.color_cn ?? null,
    size_breakdown: l.sizes ?? {},
    qty: l.qty_pcs ?? null,
  }));

  const total_qty = line_items.reduce((s, l) => s + (typeof l.qty === 'number' ? l.qty : 0), 0);

  return {
    derived: true,
    source_order_id: o.id,
    source_order_no: o.order_no,
    customer_name: o.customer_name,
    style_no: o.style_no ?? null,
    order_type: 'repeat',
    line_items,
    total_qty,
    note: `返单 payload（来源订单 ${o.order_no}）。仅供人工创建新订单使用，未写入任何数据。`,
  };
}
