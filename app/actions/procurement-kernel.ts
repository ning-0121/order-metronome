'use server';

/**
 * Procurement Kernel — 只读编排 action(ADR-005:薄壳,只 auth + 拉单一源 + 调 kernel,零计算)。
 * demand=procurement_items(MRP归并) · available=inventoryKernel · suppliers=material_supplier。
 * 全部计算在 lib/services/procurement-kernel.ts;本文件不算任何东西。
 */

import { createClient } from '@/lib/supabase/server';
import { aggregateInventoryBalance, computeAvailability, type ReservationRow } from '@/lib/services/inventory';
import { shortageTruth, sourcingTruth, executionTruth, type ShortageInput, type ScoredSupplier } from '@/lib/services/procurement-kernel';

/** 某订单的采购内核输出:缺口 / 供应商排序 / 执行步骤(只读,无副作用)。 */
export async function getOrderProcurementKernel(orderId: string): Promise<{
  data?: { shortage: any[]; execution: any[]; sourcing: Record<string, ScoredSupplier[]> }; error?: string;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  // demand:归并后的采购项(单一源;total_required_qty = Σ MRP net)
  const { data: items } = await (supabase.from('procurement_items') as any)
    .select('id, consolidation_key, material_master_id, material_name, unit, total_required_qty')
    .eq('order_id', orderId);
  if (!items || items.length === 0) return { data: { shortage: [], execution: [], sourcing: {} } };

  // available:inventoryKernel 唯一算法(computeAvailability),本文件不重算
  const { data: txns } = await (supabase.from('inventory_transactions') as any).select('material_key, material_name, unit, qty');
  const { data: resv } = await (supabase.from('inventory_reservation') as any).select('material_key, qty, status').eq('status', 'reserved');
  const availRows = computeAvailability(aggregateInventoryBalance((txns || []) as any[]), (resv || []) as ReservationRow[]);
  const availByKey = new Map(availRows.map((r) => [r.material_key, r]));

  // shortageTruth
  const shortInput: ShortageInput[] = (items as any[]).map((it) => ({
    material_key: it.consolidation_key,
    material_name: it.material_name,
    unit: it.unit,
    demand: Number(it.total_required_qty) || 0,
    available: availByKey.get(it.consolidation_key)?.available ?? 0,
  }));
  const shortage = shortageTruth(shortInput);

  // sourcingTruth:material_supplier 按 master 分组打分
  const masterIds = Array.from(new Set((items as any[]).map((it) => it.material_master_id).filter(Boolean)));
  const supByMaster = new Map<string, any[]>();
  if (masterIds.length) {
    const { data: sup } = await (supabase.from('material_supplier') as any)
      .select('material_master_id, supplier_id, unit_price, lead_days, is_preferred, suppliers(name)')
      .in('material_master_id', masterIds);
    for (const s of (sup || [])) {
      const arr = supByMaster.get(s.material_master_id) || [];
      arr.push({ supplier_id: s.supplier_id, supplier_name: s.suppliers?.name || null, unit_price: s.unit_price, lead_days: s.lead_days, is_preferred: s.is_preferred });
      supByMaster.set(s.material_master_id, arr);
    }
  }
  const sourcingByKey = new Map<string, ScoredSupplier[]>();
  for (const it of (items as any[])) {
    const rows = it.material_master_id ? (supByMaster.get(it.material_master_id) || []) : [];
    sourcingByKey.set(it.consolidation_key, sourcingTruth(rows));
  }

  // executionTruth(urgency 需 material_requirements.timing_status,当前 v1 未接 → normal;kernel 已支持,后续喂入)
  const execution = executionTruth(shortage, sourcingByKey);

  const sourcing: Record<string, ScoredSupplier[]> = {};
  for (const [k, v] of sourcingByKey) sourcing[k] = v;
  return { data: { shortage, execution, sourcing } };
}
