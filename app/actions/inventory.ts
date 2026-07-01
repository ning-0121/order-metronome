'use server';

/**
 * 库存（W0）—— append-only 流水 + 派生余额。
 * recordInventoryReceipt: 采购收货 → 自动入库(增量 delta,幂等)。
 * 领料/退料/盘点(issue/return/adjust) = W1。
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { hasRoleInGroup } from '@/lib/domain/roles';
import { aggregateInventoryBalance, computeReceiptDelta, computeOrderLeftover, materialKeyForLine } from '@/lib/services/inventory';

async function authIssueRoles() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { supabase, userId: undefined, roles: [] as string[] };
  const { data: profile } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] =
    (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  return { supabase, userId: user.id, roles };
}

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

export interface IssueInput {
  materialKey: string;
  materialName?: string | null;
  unit?: string | null;
  orderId?: string | null;
  qty: number; // 正数(领料量/退料量);issue 存负,return 存正
  note?: string;
}

/** 领料(issue,−)/退料(return,+)。CAN_ISSUE_MATERIAL 门控。v1 允许负库存。 */
async function writeInvOut(txnType: 'issue' | 'return', input: IssueInput): Promise<{ ok?: boolean; error?: string }> {
  const { supabase, userId, roles } = await authIssueRoles();
  if (!userId) return { error: '请先登录' };
  if (!hasRoleInGroup(roles, 'CAN_ISSUE_MATERIAL')) return { error: '无领料/退料权限' };
  const q = Number(input.qty);
  if (!(q > 0)) return { error: '数量必须大于 0' };
  if (!input.materialKey) return { error: '物料必填' };

  const { error } = await (supabase.from('inventory_transactions') as any).insert({
    material_key: input.materialKey,
    material_name: input.materialName ?? null,
    unit: input.unit ?? null,
    txn_type: txnType,
    qty: txnType === 'issue' ? -q : q, // 领料 −;退料 +
    order_id: input.orderId || null,
    created_by: userId,
    note: input.note || null,
  });
  if (error) return { error: error.message };
  revalidatePath('/procurement/inventory');
  return { ok: true };
}

export async function recordInventoryIssue(input: IssueInput) { return writeInvOut('issue', input); }
export async function recordInventoryReturn(input: IssueInput) { return writeInvOut('return', input); }

/** 库存流水(审计,可按物料筛)。 */
export async function getInventoryTransactions(materialKey?: string): Promise<{ data?: any[]; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  let q = (supabase.from('inventory_transactions') as any)
    .select('id, material_key, material_name, unit, txn_type, qty, order_id, note, created_at')
    .order('created_at', { ascending: false }).limit(200);
  if (materialKey) q = q.eq('material_key', materialKey);
  const { data, error } = await q;
  if (error) return { error: error.message };
  return { data: data || [] };
}

/** 真尾货(按订单,逐物料)= received − consumed。派生,单一来源 inventory_transactions。 */
export async function getOrderLeftover(orderId: string): Promise<{ data?: any[]; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data: txns, error } = await (supabase.from('inventory_transactions') as any)
    .select('material_key, material_name, unit, txn_type, qty').eq('order_id', orderId);
  if (error) return { error: error.message };
  return { data: computeOrderLeftover((txns || []) as any[]) };
}

/** 领料可挂的订单列表(CAN_ISSUE_MATERIAL)。 */
export async function listOrdersForIssue(limit = 100): Promise<{ data?: any[]; error?: string }> {
  const { supabase, userId, roles } = await authIssueRoles();
  if (!userId) return { error: '请先登录' };
  if (!hasRoleInGroup(roles, 'CAN_ISSUE_MATERIAL')) return { error: '无权' };
  const { data, error } = await (supabase.from('orders') as any)
    .select('id, order_no, internal_order_no, customer_name')
    .neq('lifecycle_status', 'cancelled').order('created_at', { ascending: false }).limit(limit);
  if (error) return { error: error.message };
  return { data: data || [] };
}
