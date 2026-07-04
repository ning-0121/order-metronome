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
    .select('id, order_id, material_name, specification, category, ordered_qty, ordered_unit, procurement_item_id')
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

  // 审计 P0:执行行无 master_id/color 列,经 procurement_item_id 回查主数据,
  // 让 netting 归并键与库存/采购项同口径(master 优先 + 含颜色)。
  const piIds = [...new Set(rows.map((l) => l.procurement_item_id).filter(Boolean))];
  const piMap = new Map<string, any>();
  if (piIds.length) {
    const { data: pis } = await (supabase.from('procurement_items') as any)
      .select('id, material_master_id, color').in('id', piIds);
    for (const p of (pis || []) as any[]) piMap.set(p.id, p);
  }

  const enriched: NettingLine[] = rows.map((l) => {
    const pi = l.procurement_item_id ? piMap.get(l.procurement_item_id) : null;
    return {
      id: l.id,
      order_id: l.order_id,
      order_no: orderMap.get(l.order_id)?.order_no ?? null,
      internal_order_no: orderMap.get(l.order_id)?.internal_order_no ?? null,
      material_master_id: pi?.material_master_id ?? null,
      material_name: l.material_name,
      specification: l.specification,
      category: l.category,
      color: pi?.color ?? null,
      ordered_qty: l.ordered_qty,
      ordered_unit: l.ordered_unit,
    };
  });

  return { data: aggregateLinesByKey(enriched) };
}
