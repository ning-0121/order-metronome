'use server';

/**
 * 采购成本核算（P4 A+C）—— 派生视图 + 显式回填。
 * 成本/金额受 CAN_SEE_PROCUREMENT_FLOOR（采购/采购经理/财务/admin）；业务不看。
 * 回填 actual_material_cost 只在人工点回填时写（标来源=采购），避免与成本表双源。
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { hasRoleInGroup } from '@/lib/domain/roles';
import { computeProcurementCostSummary, computeReceivingDiff } from '@/lib/services/procurement-cost';
import { calculateProfitSnapshot } from '@/lib/services/profit.service';

async function authFloor() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { supabase, userId: undefined, canFloor: false };
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles').eq('user_id', user.id).single();
  const roles: string[] =
    (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  return { supabase, userId: user.id, canFloor: hasRoleInGroup(roles, 'CAN_SEE_PROCUREMENT_FLOOR') };
}

/** 有采购行的订单列表（成本核算入口索引）。 */
export async function listOrdersWithProcurement(limit = 50): Promise<{ data?: any[]; error?: string }> {
  const { supabase, userId, canFloor } = await authFloor();
  if (!userId) return { error: '请先登录' };
  if (!canFloor) return { error: '无权查看采购成本' };
  const { data: lines } = await (supabase.from('procurement_line_items') as any)
    .select('order_id').order('created_at', { ascending: false });
  const orderIds = [...new Set((lines || []).map((l: any) => l.order_id).filter(Boolean))].slice(0, limit);
  if (orderIds.length === 0) return { data: [] };
  const { data: orders } = await (supabase.from('orders') as any)
    .select('id, order_no, internal_order_no, customer_name, lifecycle_status').in('id', orderIds);
  return { data: orders || [] };
}

/** 采购成本核算 + 订收差异（派生，只读）。 */
export async function getProcurementCostSummary(orderId: string): Promise<{ data?: any; error?: string }> {
  const { supabase, userId, canFloor } = await authFloor();
  if (!userId) return { error: '请先登录' };
  if (!canFloor) return { error: '无权查看采购成本' };

  const { data: order } = await (supabase.from('orders') as any)
    .select('id, order_no, internal_order_no, customer_name').eq('id', orderId).maybeSingle();
  if (!order) return { error: '订单不存在' };

  const { data: lines } = await (supabase.from('procurement_line_items') as any)
    .select('material_name, category, ordered_unit, ordered_qty, received_qty, unit_price, ordered_amount')
    .eq('order_id', orderId);

  const { data: fin } = await (supabase.from('order_financials') as any)
    .select('budgeted_material_cost, actual_material_cost').eq('order_id', orderId).maybeSingle();

  const budget = (fin as any)?.budgeted_material_cost != null ? Number((fin as any).budgeted_material_cost) : null;
  const summary = computeProcurementCostSummary((lines || []) as any[], budget);
  const receivingDiff = computeReceivingDiff((lines || []) as any[]);

  return {
    data: {
      order,
      summary,
      receivingDiff,
      current_actual_material_cost: (fin as any)?.actual_material_cost ?? null,
    },
  };
}

/** 显式回填：以采购实际成本写 order_financials.actual_material_cost + 重算利润（人工触发）。 */
export async function backfillActualMaterialCost(orderId: string): Promise<{ error?: string; ok?: boolean; actual?: number }> {
  const { supabase, userId, canFloor } = await authFloor();
  if (!userId) return { error: '请先登录' };
  if (!canFloor) return { error: '无权回填采购成本' };

  const { data: lines } = await (supabase.from('procurement_line_items') as any)
    .select('ordered_qty, received_qty, unit_price, ordered_amount').eq('order_id', orderId);
  const summary = computeProcurementCostSummary((lines || []) as any[], null);

  // upsert order_financials.actual_material_cost（该字段现由成本表也能填 → 此为人工选"用采购实际"）
  const { data: existing } = await (supabase.from('order_financials') as any)
    .select('id').eq('order_id', orderId).maybeSingle();
  if (existing) {
    const { error } = await (supabase.from('order_financials') as any)
      .update({ actual_material_cost: summary.actual_cost, updated_at: new Date().toISOString() }).eq('order_id', orderId);
    if (error) return { error: error.message };
  } else {
    const { error } = await (supabase.from('order_financials') as any)
      .insert({ order_id: orderId, actual_material_cost: summary.actual_cost });
    if (error) return { error: error.message };
  }

  // 重算利润快照（复用现有 profit.service，与 cost-control 同口径）
  try { await calculateProfitSnapshot(supabase, { orderId, snapshotType: 'live' }); } catch { /* 利润重算失败不阻断回填 */ }

  revalidatePath(`/procurement/cost/${orderId}`);
  return { ok: true, actual: summary.actual_cost };
}
