'use server';

/**
 * 库存（W0）—— append-only 流水 + 派生余额。
 * recordInventoryReceipt: 采购收货 → 自动入库(增量 delta,幂等)。
 * 领料/退料/盘点(issue/return/adjust) = W1。
 */

import { createClient } from '@/lib/supabase/server';
import { aggregateInventoryBalance, computeReceiptDelta, materialKeyForLine } from '@/lib/services/inventory';

/** 采购行收货 → 自动入库(增量)。多次收货/更正只补差额。append-only。 */
export async function recordInventoryReceipt(lineId: string): Promise<{ ok?: boolean; delta?: number; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: line } = await (supabase.from('procurement_line_items') as any)
    .select('id, order_id, material_name, specification, category, ordered_unit, received_qty')
    .eq('id', lineId).maybeSingle();
  if (!line) return { error: '采购行不存在' };

  const received = Number((line as any).received_qty) || 0;

  // 已入库(该行 receipt 流水 Σ)
  const { data: prior } = await (supabase.from('inventory_transactions') as any)
    .select('qty').eq('source_ref', lineId).eq('txn_type', 'receipt');
  const priorSum = ((prior || []) as any[]).reduce((s, t) => s + (Number(t.qty) || 0), 0);

  const delta = computeReceiptDelta(received, priorSum);
  if (delta === 0) return { ok: true, delta: 0 };

  const { error } = await (supabase.from('inventory_transactions') as any).insert({
    material_key: materialKeyForLine(line as any),
    material_name: (line as any).material_name,
    unit: (line as any).ordered_unit,
    txn_type: 'receipt',
    qty: delta,
    order_id: (line as any).order_id,
    source_ref: lineId,
    created_by: user.id,
    note: '采购收货自动入库',
  });
  if (error) return { error: error.message };
  return { ok: true, delta };
}

/** 派生库存余额(按物料 Σ 流水)。 */
export async function getInventoryBalance(): Promise<{ data?: any[]; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data: txns, error } = await (supabase.from('inventory_transactions') as any)
    .select('material_key, material_name, unit, qty');
  if (error) return { error: error.message };
  return { data: aggregateInventoryBalance((txns || []) as any[]) };
}
