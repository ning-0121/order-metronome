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


// 审计修(2026-07-04):补齐全部 line_status,避免 ready_to_ship/rejected/cancelled 的行
// 落不进任何桶、从概览凭空消失(四桶之和 < lines.length,与采购工作台两张皮)。
const PENDING = new Set(['draft', 'pending_order']);
const TRANSIT = new Set(['ordered', 'confirmed', 'in_production', 'ready_to_ship', 'shipped']);
const ARRIVED = new Set(['arrived']);
const DONE = new Set(['accepted', 'closed', 'concession', 'cancelled']);
// 合并拆码行时,组内混态取"最不推进"的作代表(数越小越早)→ 业务视角宁可显示为未完成
const STATUS_RANK: Record<string, number> = {
  draft: 0, pending_order: 1, ordered: 2, confirmed: 3, in_production: 4,
  ready_to_ship: 5, shipped: 6, arrived: 7, partially_received: 8, received: 9,
  accepted: 10, concession: 10, closed: 11, cancelled: 12,
};
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
  procurement_item_id?: string | null;
  size_lines?: number;   // 该料+色被拆成几行尺码(>1 说明是合并显示)
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

  // 复审性能:一次 getUserRoles 同时派生 fin 与 canSeeFloor(此前 canSeeFinancials 另查一次同表同列)
  // unit_price=大货底价 → 归属 CAN_SEE_PROCUREMENT_FLOOR(采购/财务/admin),**不是** canSeeFinancials(含 sales)。
  const roles = await getUserRoles(supabase, user.id);
  const fin = hasRoleInGroup(roles, 'CAN_SEE_FINANCIALS');
  const canSeeFloor = hasRoleInGroup(roles, 'CAN_SEE_PROCUREMENT_FLOOR');
  const cols =
    'id, procurement_item_id, material_name, category, line_status, ordered_qty, ordered_unit, received_qty, required_by, expected_arrival, supplier_name' +
    (canSeeFloor ? ', unit_price' : '');
  const { data: lines, error: linesErr } = await ((canSeeFloor ? createServiceRoleClient() : supabase).from('procurement_line_items') as any)
    .select(cols)
    .eq('order_id', orderId)
    .order('category', { ascending: true });
  if (linesErr) return { error: friendlyError(linesErr) };

  // 业务视角合并拆码执行行(2026-07-08 用户):同一采购项(procurement_item_id)被 N1 按 S/M/L 拆成多行,
  // 业务视角看到"3 个主吊牌"像重复且是奇数。这里按采购项合并成 料+色 一行(数量求和、需到日取最早、
  // 尺码行数留痕),与采购对账口径一致;采购中心仍保留逐码行供归单。老行(无采购项)各自成行不合并。
  const grouped = new Map<string, any>();
  for (const l of ((lines || []) as any[])) {
    const key = l.procurement_item_id || `__row_${l.id}`;
    const g = grouped.get(key);
    if (!g) { grouped.set(key, { ...l, size_lines: 1 }); continue; }
    g.ordered_qty = (Number(g.ordered_qty) || 0) + (Number(l.ordered_qty) || 0);
    g.received_qty = (Number(g.received_qty) || 0) + (Number(l.received_qty) || 0);
    if (l.required_by && (!g.required_by || l.required_by < g.required_by)) g.required_by = l.required_by;   // 宁早勿晚
    if (l.expected_arrival && (!g.expected_arrival || l.expected_arrival < g.expected_arrival)) g.expected_arrival = l.expected_arrival;
    // 组内状态一般一致(同时生成/推进);若混态取"最不推进"的,业务视角宁可显示为未完成
    if (STATUS_RANK[l.line_status] != null && (STATUS_RANK[g.line_status] == null || STATUS_RANK[l.line_status] < STATUS_RANK[g.line_status])) g.line_status = l.line_status;
    g.size_lines++;
  }
  const mergedLines = [...grouped.values()];

  const today = new Date().toISOString().slice(0, 10);
  let pending = 0, inTransit = 0, arrived = 0, done = 0, attention = 0;
  const byCategory: Record<string, number> = {};
  const rows: SupplyChainLine[] = mergedLines.map((l) => {
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

  // 复审性能:BOM 计数 / 收货概要 / 物料预算 三个独立查询并行(此前顺序 await 三轮往返)
  const [bomRes, receiptsRes, budgetRes] = await Promise.all([
    (supabase.from('materials_bom') as any).select('id', { count: 'exact', head: true }).eq('order_id', orderId),
    (supabase.from('goods_receipts') as any).select('inspection_result').eq('order_id', orderId),
    fin
      ? (supabase.from('order_cost_baseline') as any).select('budget_fabric_kg, budget_fabric_amount, fabric_consumption_kg').eq('order_id', orderId).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const bomCount = (bomRes as any)?.count ?? 0;
  const receipts = (receiptsRes as any)?.data;
  const rc = { total: (receipts || []).length, pass: 0, concession: 0, reject: 0, pending: 0 };
  for (const r of (receipts || []) as any[]) {
    const k = r.inspection_result;
    if (k === 'pass') rc.pass++;
    else if (k === 'concession') rc.concession++;
    else if (k === 'reject') rc.reject++;
    else rc.pending++;
  }
  const budget: SupplyChainOverview['budget'] = ((budgetRes as any)?.data as any) || null;

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
