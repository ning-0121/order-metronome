'use server';

/**
 * Procurement Kernel — 只读编排 action(ADR-005:薄壳,只 auth + 拉单一源 + 调 kernel,零计算)。
 * demand=procurement_items(MRP归并) · available=inventoryKernel · suppliers=material_supplier。
 * 全部计算在 lib/services/procurement-kernel.ts;本文件不算任何东西。
 */

import { createClient } from '@/lib/supabase/server';
import { hasRoleInGroup } from '@/lib/domain/roles';
import { aggregateInventoryBalance, computeAvailability, type ReservationRow } from '@/lib/services/inventory';
import { shortageTruth, sourcingTruth, executionTruth, type ShortageInput, type ScoredSupplier } from '@/lib/services/procurement-kernel';

/** P1:非采购/财务角色屏蔽大货底价(unit_price),保留排序/交期/供应商名。 */
function maskFloor(rows: ScoredSupplier[]): ScoredSupplier[] {
  return rows.map((r) => ({ ...r, unit_price: null }));
}

/** 某订单的采购内核输出:缺口 / 供应商排序 / 执行步骤(只读,无副作用)。 */
export async function getOrderProcurementKernel(orderId: string): Promise<{
  data?: { shortage: any[]; execution: any[]; sourcing: Record<string, ScoredSupplier[]>; canSeeFloor: boolean }; error?: string;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  // P1:角色 → 是否可见大货底价(CAN_SEE_PROCUREMENT_FLOOR = admin/finance/采购)
  const { data: profile } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  const canSeeFloor = hasRoleInGroup(roles, 'CAN_SEE_PROCUREMENT_FLOOR');

  // demand:归并后的采购项(单一源;total_required_qty = Σ MRP net)
  const { data: items } = await (supabase.from('procurement_items') as any)
    .select('id, consolidation_key, material_master_id, material_name, unit, total_required_qty')
    .eq('order_id', orderId);
  if (!items || items.length === 0) return { data: { shortage: [], execution: [], sourcing: {}, canSeeFloor } };

  // P1:安全库存(material_master.safety_stock_qty)→ 按 consolidation_key 建 safetyByKey,喂进唯一可用量算法
  const masterIds = Array.from(new Set((items as any[]).map((it) => it.material_master_id).filter(Boolean)));
  const masterSafety = new Map<string, number>();
  if (masterIds.length) {
    const { data: mm } = await (supabase.from('material_master') as any).select('id, safety_stock_qty').in('id', masterIds);
    for (const m of (mm || [])) masterSafety.set(m.id, Number(m.safety_stock_qty) || 0);
  }
  const safetyByKey = new Map<string, number>();
  for (const it of (items as any[])) {
    if (it.material_master_id && masterSafety.has(it.material_master_id)) safetyByKey.set(it.consolidation_key, masterSafety.get(it.material_master_id)!);
  }

  // available:inventoryKernel 唯一算法(computeAvailability,含 safety),本文件不重算
  const { data: txns } = await (supabase.from('inventory_transactions') as any).select('material_key, material_name, unit, qty');
  const { data: resv } = await (supabase.from('inventory_reservation') as any).select('material_key, qty, status').eq('status', 'reserved');
  const availRows = computeAvailability(aggregateInventoryBalance((txns || []) as any[]), (resv || []) as ReservationRow[], safetyByKey);
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
    const scored = sourcingTruth(rows);
    sourcingByKey.set(it.consolidation_key, canSeeFloor ? scored : maskFloor(scored)); // P1:底价按角色屏蔽
  }

  // executionTruth(用已屏蔽的 sourcing;urgency 需 material_requirements.timing_status,v1 未接 → normal)
  const execution = executionTruth(shortage, sourcingByKey);

  const sourcing: Record<string, ScoredSupplier[]> = {};
  for (const [k, v] of sourcingByKey) sourcing[k] = v;
  return { data: { shortage, execution, sourcing, canSeeFloor } };
}
