'use server';

/**
 * 供应链域 — 订单级只读概览(Phase 1)。
 * 纯归集现有表:procurement_line_items / materials_bom / goods_receipts / order_cost_baseline。
 * 不新建仓库/库存/批次,不改采购主流程,不做拦截。成本字段按 CAN_SEE_FINANCIALS 红线门控。
 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { friendlyError } from '@/lib/utils/db-error';
import { hasRoleInGroup } from '@/lib/domain/roles';
import { getUserRoles } from '@/lib/utils/user-role';

async function canSeeFinancials(supabase: any, userId: string): Promise<boolean> {
  const { data: p } = await (supabase.from('profiles') as any)
    .select('role, roles').eq('user_id', userId).single();
  const roles: string[] = (p as any)?.roles?.length > 0 ? (p as any).roles : [(p as any)?.role].filter(Boolean);
  return hasRoleInGroup(roles, 'CAN_SEE_FINANCIALS');
}

// 审计修(2026-07-04):补齐全部 line_status,避免 ready_to_ship/rejected/cancelled 的行
// 落不进任何桶、从概览凭空消失(四桶之和 < lines.length,与采购工作台两张皮)。
const PENDING = new Set(['draft', 'pending_order']);
const TRANSIT = new Set(['ordered', 'confirmed', 'in_production', 'ready_to_ship', 'shipped']);
const ARRIVED = new Set(['arrived']);
const DONE = new Set(['accepted', 'closed', 'concession', 'cancelled']);
// rejected(质检拒收)→ 归"需关注",不算完成

export interface SupplyChainLine {
  id: string;
  material_name: string | null;
  category: string | null;
  line_status: string;
  ordered_qty: number | null;
  ordered_unit: string | null;
  received_qty: number | null;
  required_by: string | null;
  expected_arrival: string | null;
  supplier_name: string | null;
  overdue: boolean;
  unit_price?: number | null;
}

export interface SupplyChainOverview {
  canSeeFinancials: boolean;
  lines: SupplyChainLine[];
  statusCounts: { pending: number; inTransit: number; arrived: number; done: number };
  byCategory: Record<string, number>;
  attentionCount: number;
  bomCount: number;
  receipts: { total: number; pass: number; concession: number; reject: number; pending: number };
  budget: { budget_fabric_kg: number | null; budget_fabric_amount: number | null; fabric_consumption_kg: number | null } | null;
}

export async function getOrderSupplyChainOverview(
  orderId: string,
): Promise<{ data?: SupplyChainOverview; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const fin = await canSeeFinancials(supabase, user.id);

  // 采购物料行。unit_price=大货底价 → 归属 CAN_SEE_PROCUREMENT_FLOOR(采购/财务/admin),
  // **不是** canSeeFinancials(含 sales!之前挂在 fin 上会把底价泄给业务)。
  // 底价列已列级封锁 → 含价时经 service-role 读(本处 canSeeFloor 门禁),否则用户会话不取价。
  const roles = await getUserRoles(supabase, user.id);
  const canSeeFloor = hasRoleInGroup(roles, 'CAN_SEE_PROCUREMENT_FLOOR');
  const cols =
    'id, material_name, category, line_status, ordered_qty, ordered_unit, received_qty, required_by, expected_arrival, supplier_name' +
    (canSeeFloor ? ', unit_price' : '');
  const { data: lines, error: linesErr } = await ((canSeeFloor ? createServiceRoleClient() : supabase).from('procurement_line_items') as any)
    .select(cols)
    .eq('order_id', orderId)
    .order('category', { ascending: true });
  if (linesErr) return { error: friendlyError(linesErr) };

  const today = new Date().toISOString().slice(0, 10);
  let pending = 0, inTransit = 0, arrived = 0, done = 0, attention = 0;
  const byCategory: Record<string, number> = {};
  const rows: SupplyChainLine[] = ((lines || []) as any[]).map((l) => {
    const st = String(l.line_status || '');
    if (PENDING.has(st)) pending++;
    else if (TRANSIT.has(st)) inTransit++;
    else if (ARRIVED.has(st)) arrived++;
    else if (DONE.has(st)) done++;
    else attention++;   // rejected 及任何未归类状态 → 需关注(不再凭空消失)
    const cat = l.category || 'other';
    byCategory[cat] = (byCategory[cat] || 0) + 1;
    // 需关注:需到日已过,且还没到厂/验收(只读判断,不拦截)。已在 else 计过的不重复加。
    const overdue = !!l.required_by && l.required_by < today && !ARRIVED.has(st) && !DONE.has(st)
      && (PENDING.has(st) || TRANSIT.has(st));
    if (overdue) attention++;
    return { ...l, overdue };
  });

  // BOM 物料项数
  const { count: bomCount } = await (supabase.from('materials_bom') as any)
    .select('id', { count: 'exact', head: true })
    .eq('order_id', orderId);

  // 到货验收概要
  const { data: receipts } = await (supabase.from('goods_receipts') as any)
    .select('inspection_result')
    .eq('order_id', orderId);
  const rc = { total: (receipts || []).length, pass: 0, concession: 0, reject: 0, pending: 0 };
  for (const r of (receipts || []) as any[]) {
    const k = r.inspection_result;
    if (k === 'pass') rc.pass++;
    else if (k === 'concession') rc.concession++;
    else if (k === 'reject') rc.reject++;
    else rc.pending++;
  }

  // 物料预算(仅财务)
  let budget: SupplyChainOverview['budget'] = null;
  if (fin) {
    const { data: b } = await (supabase.from('order_cost_baseline') as any)
      .select('budget_fabric_kg, budget_fabric_amount, fabric_consumption_kg')
      .eq('order_id', orderId)
      .maybeSingle();
    budget = (b as any) || null;
  }

  return {
    data: {
      canSeeFinancials: fin,
      lines: rows,
      statusCounts: { pending, inTransit, arrived, done },
      byCategory,
      attentionCount: attention,
      bomCount: bomCount || 0,
      receipts: rc,
      budget,
    },
  };
}
