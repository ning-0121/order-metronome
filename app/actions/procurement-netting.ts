'use server';

/**
 * 跨订单 netting 读取（P3 A）—— 纯派生。
 * 未归单待下单行(purchase_order_id IS NULL) 跨所有订单，按 consolidation_key 聚合。
 * 只读，不写库；建单走 P1 createPurchaseOrder。netting 组不含价，天然无底价泄露。
 */

import { createClient } from '@/lib/supabase/server';
import { aggregateLinesByKey, type NettingLine, type NettingGroup } from '@/lib/services/netting';

export async function getCrossOrderNetting(): Promise<{ data?: NettingGroup[]; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: lines, error } = await (supabase.from('procurement_line_items') as any)
    .select('id, order_id, material_name, specification, category, ordered_qty, ordered_unit')
    .is('purchase_order_id', null)
    .order('material_name', { ascending: true });
  if (error) return { error: error.message };

  const rows = (lines || []) as any[];
  if (rows.length === 0) return { data: [] };

  // 订单双号
  const orderIds = [...new Set(rows.map((l) => l.order_id).filter(Boolean))];
  const orderMap = new Map<string, any>();
  if (orderIds.length) {
    const { data: ords } = await (supabase.from('orders') as any)
      .select('id, order_no, internal_order_no').in('id', orderIds);
    for (const o of (ords || []) as any[]) orderMap.set(o.id, o);
  }

  const enriched: NettingLine[] = rows.map((l) => ({
    id: l.id,
    order_id: l.order_id,
    order_no: orderMap.get(l.order_id)?.order_no ?? null,
    internal_order_no: orderMap.get(l.order_id)?.internal_order_no ?? null,
    material_name: l.material_name,
    specification: l.specification,
    category: l.category,
    ordered_qty: l.ordered_qty,
    ordered_unit: l.ordered_unit,
  }));

  return { data: aggregateLinesByKey(enriched) };
}
