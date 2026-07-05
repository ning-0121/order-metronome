'use server';

/**
 * 生产中心(2026-07-05 Phase 1)—— 跨订单生产执行分析 HUB。
 * 生命周期四段(新订单待采购 → 物料在途 → 开生产待排单 → 生产中)+ 风险单。
 * 一旦业务建单即进本中心(不过滤新单/待审);仅排除 已取消/已完成/归档。
 * 权限:生产/生产经理/理单/管理员。生产(非经理)只看分配到自己的订单。
 * **只暴露 数量/物料就绪/工厂/生产节点**,不含售价/毛利/成本(生产角色红线)。
 * 纯派生只读,不写库,确定性。
 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { hasRoleInGroup } from '@/lib/domain/roles';

export type ProductionStage = 'awaiting_procurement' | 'materials_in_transit' | 'ready_to_schedule' | 'in_production';

export interface ProductionOrderRow {
  order_id: string;
  order_no: string | null;
  internal_order_no: string | null;
  customer_name: string | null;
  factory_name: string | null;
  quantity: number | null;
  factory_date: string | null;
  etd: string | null;
  stage: ProductionStage;
  risk: boolean;   // 生产节点逾期(未处置)
  has_mo: boolean; // 已建生产任务单(可下载)
  material: { total: number; received: number; in_transit: number; pending: number };
  kickoff: { status: string | null; due: string | null } | null;      // 生产启动/开裁
  completion: { status: string | null; due: string | null } | null;    // 工厂完成
}

export interface ProductionCenterSummary {
  total: number;
  awaiting_procurement: number;
  materials_in_transit: number;
  ready_to_schedule: number;
  in_production: number;
  risk: number;
}

const DONE = (s: string | null | undefined) => ['done', 'completed', '已完成'].includes(String(s || '').toLowerCase());
const RECEIVED = new Set(['received', 'accepted', 'closed', 'concession']);
const IN_TRANSIT = new Set(['ordered', 'confirmed', 'in_production', 'ready_to_ship', 'shipped', 'arrived']);
const NOT_SECURED = new Set(['draft', 'pending_order']);

function computeStage(
  m: ProductionOrderRow['material'],
  kickoff: ProductionOrderRow['kickoff'],
  completion: ProductionOrderRow['completion'],
): ProductionStage | 'done' {
  if (completion && DONE(completion.status)) return 'done';   // 工厂已完工 → 出生产中心
  if (kickoff && DONE(kickoff.status)) return 'in_production'; // 已开裁 → 生产中
  if (m.total === 0 || m.pending > 0) return 'awaiting_procurement'; // 有料未下单/未起料 → 待采购
  if (m.received === m.total) return 'ready_to_schedule';           // 料齐未开裁 → 待排单
  return 'materials_in_transit';                                     // 已下单未到齐 → 在途
}

export async function getProductionCenter(): Promise<{
  data?: ProductionOrderRow[]; summary?: ProductionCenterSummary; error?: string;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data: prof } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (prof as any)?.roles?.length > 0 ? (prof as any).roles : [(prof as any)?.role].filter(Boolean);
  if (!roles.some((r) => ['production', 'production_manager', 'merchandiser', 'order_manager', 'admin'].includes(r))) {
    return { error: '无权查看生产中心' };
  }
  // 生产经理/理单/管理层看全部;生产(非经理)/跟单只看分配到自己的单
  const canSeeAll = roles.includes('admin') || hasRoleInGroup(roles, 'CAN_SEE_ALL_ORDERS');

  const svc = createServiceRoleClient();

  // 分配范围(非全看):自己 owner / 自己建 / 被指派了节点的订单
  let allowedIds: Set<string> | null = null;
  if (!canSeeAll) {
    const [{ data: owned }, { data: created }, { data: assigned }] = await Promise.all([
      (svc.from('orders') as any).select('id').eq('owner_user_id', user.id),
      (svc.from('orders') as any).select('id').eq('created_by', user.id),
      (svc.from('milestones') as any).select('order_id').eq('owner_user_id', user.id),
    ]);
    allowedIds = new Set<string>([
      ...(owned || []).map((o: any) => o.id),
      ...(created || []).map((o: any) => o.id),
      ...(assigned || []).map((m: any) => m.order_id),
    ]);
    if (allowedIds.size === 0) return { data: [], summary: emptySummary() };
  }

  // 建单即进(仅排除 已取消/已完成/归档;保留 draft/pending_approval/active)
  let q = (svc.from('orders') as any)
    .select('id, order_no, internal_order_no, customer_name, factory_name, quantity, factory_date, etd, lifecycle_status')
    .not('lifecycle_status', 'in', '("completed","已完成","cancelled","已取消","archived","已归档")');
  if (allowedIds) q = q.in('id', Array.from(allowedIds));
  const { data: orders } = await q;
  const list = (orders || []) as any[];
  if (list.length === 0) return { data: [], summary: emptySummary() };
  const orderIds = list.map((o) => o.id);

  // 物料就绪 + 生产节点 + 生产任务单存在性(三查并行)
  const [{ data: lines }, { data: ms }, { data: mos }] = await Promise.all([
    (svc.from('procurement_line_items') as any).select('order_id, line_status').in('order_id', orderIds),
    (svc.from('milestones') as any).select('order_id, step_key, status, due_at')
      .in('order_id', orderIds).in('step_key', ['production_kickoff', 'factory_completion']),
    (svc.from('manufacturing_orders') as any).select('order_id').in('order_id', orderIds),
  ]);

  const matByOrder = new Map<string, ProductionOrderRow['material']>();
  for (const l of (lines || []) as any[]) {
    const m = matByOrder.get(l.order_id) || { total: 0, received: 0, in_transit: 0, pending: 0 };
    m.total++;
    const st = String(l.line_status || '');
    if (RECEIVED.has(st)) m.received++;
    else if (NOT_SECURED.has(st)) m.pending++;
    else if (IN_TRANSIT.has(st)) m.in_transit++;
    matByOrder.set(l.order_id, m);
  }

  const msByOrder = new Map<string, Record<string, { status: string | null; due: string | null }>>();
  for (const m of (ms || []) as any[]) {
    const o = msByOrder.get(m.order_id) || {};
    o[m.step_key] = { status: m.status ?? null, due: m.due_at ? String(m.due_at).slice(0, 10) : null };
    msByOrder.set(m.order_id, o);
  }
  const moSet = new Set<string>((mos || []).map((r: any) => r.order_id));

  const today = new Date().toISOString().slice(0, 10);
  const rows: ProductionOrderRow[] = [];
  for (const o of list) {
    const m = matByOrder.get(o.id) || { total: 0, received: 0, in_transit: 0, pending: 0 };
    const mo = msByOrder.get(o.id) || {};
    const kickoff = mo['production_kickoff'] || null;
    const completion = mo['factory_completion'] || null;
    const stage = computeStage(m, kickoff, completion);
    if (stage === 'done') continue;   // 工厂已完工,出中心
    const risk = [kickoff, completion].some((n) => n && !DONE(n.status) && n.due && n.due < today);
    rows.push({
      order_id: o.id, order_no: o.order_no, internal_order_no: o.internal_order_no, customer_name: o.customer_name,
      factory_name: o.factory_name, quantity: o.quantity,
      factory_date: o.factory_date ? String(o.factory_date).slice(0, 10) : null,
      etd: o.etd ? String(o.etd).slice(0, 10) : null,
      stage, risk, has_mo: moSet.has(o.id), material: m, kickoff, completion,
    });
  }

  const STAGE_ORDER: ProductionStage[] = ['awaiting_procurement', 'materials_in_transit', 'ready_to_schedule', 'in_production'];
  rows.sort((a, b) => {
    if (a.risk !== b.risk) return a.risk ? -1 : 1;   // 风险优先
    const s = STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage);
    return s || (a.factory_date || '9999').localeCompare(b.factory_date || '9999');
  });

  const summary: ProductionCenterSummary = {
    total: rows.length,
    awaiting_procurement: rows.filter((r) => r.stage === 'awaiting_procurement').length,
    materials_in_transit: rows.filter((r) => r.stage === 'materials_in_transit').length,
    ready_to_schedule: rows.filter((r) => r.stage === 'ready_to_schedule').length,
    in_production: rows.filter((r) => r.stage === 'in_production').length,
    risk: rows.filter((r) => r.risk).length,
  };
  return { data: rows, summary };
}

function emptySummary(): ProductionCenterSummary {
  return { total: 0, awaiting_procurement: 0, materials_in_transit: 0, ready_to_schedule: 0, in_production: 0, risk: 0 };
}
