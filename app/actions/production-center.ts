'use server';

/**
 * 生产中心(2026-07-05 Phase 1)—— 跨订单生产执行分析 HUB。
 * 规格 §1 生产执行分析(READY/PARTIAL/BLOCKED,按物料就绪派生)+ §5 节拍同步(生产节点要不要动)。
 * 权限:生产/生产经理/理单/管理员可看。**只暴露 数量/物料就绪/工厂/生产节点**,
 * 不含售价/毛利/成本(生产角色红线)。纯派生只读,不写库。确定性,不猜。
 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';

export type ProductionStatus = 'READY' | 'PARTIAL' | 'BLOCKED' | 'NO_MATERIALS';

export interface ProductionOrderRow {
  order_id: string;
  order_no: string | null;
  internal_order_no: string | null;
  customer_name: string | null;
  factory_name: string | null;
  quantity: number | null;
  factory_date: string | null;
  etd: string | null;
  production_status: ProductionStatus;
  material: { total: number; received: number; in_transit: number; pending: number };
  kickoff: { status: string | null; due: string | null } | null;      // 生产启动/开裁
  completion: { status: string | null; due: string | null } | null;    // 工厂完成
  overdue: boolean;   // 生产节点逾期(未处置)
}

const DONE = (s: string) => ['done', 'completed', '已完成'].includes(String(s || '').toLowerCase());
const RECEIVED = new Set(['received', 'accepted', 'closed', 'concession']);
const IN_TRANSIT = new Set(['ordered', 'confirmed', 'in_production', 'ready_to_ship', 'shipped', 'arrived']);
const NOT_SECURED = new Set(['draft', 'pending_order']);

export async function getProductionCenter(): Promise<{ data?: ProductionOrderRow[]; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data: prof } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (prof as any)?.roles?.length > 0 ? (prof as any).roles : [(prof as any)?.role].filter(Boolean);
  if (!roles.some((r) => ['production', 'production_manager', 'merchandiser', 'order_manager', 'admin'].includes(r))) {
    return { error: '无权查看生产中心' };
  }

  const svc = createServiceRoleClient();
  const { data: orders } = await (svc.from('orders') as any)
    .select('id, order_no, internal_order_no, customer_name, factory_name, quantity, factory_date, etd, lifecycle_status')
    .not('lifecycle_status', 'in', '("draft","pending_approval","completed","已完成","cancelled","已取消","archived","已归档")');
  const list = (orders || []) as any[];
  if (list.length === 0) return { data: [] };
  const orderIds = list.map((o) => o.id);

  // 物料就绪(采购执行行按订单聚合)
  const { data: lines } = await (svc.from('procurement_line_items') as any)
    .select('order_id, line_status').in('order_id', orderIds);
  const matByOrder = new Map<string, { total: number; received: number; in_transit: number; pending: number }>();
  for (const l of (lines || []) as any[]) {
    const m = matByOrder.get(l.order_id) || { total: 0, received: 0, in_transit: 0, pending: 0 };
    m.total++;
    const st = String(l.line_status || '');
    if (RECEIVED.has(st)) m.received++;
    else if (NOT_SECURED.has(st)) m.pending++;
    else if (IN_TRANSIT.has(st)) m.in_transit++;
    matByOrder.set(l.order_id, m);
  }

  // 生产节点(启动/完成)
  const { data: ms } = await (svc.from('milestones') as any)
    .select('order_id, step_key, status, due_at').in('order_id', orderIds)
    .in('step_key', ['production_kickoff', 'factory_completion']);
  const msByOrder = new Map<string, Record<string, { status: string | null; due: string | null }>>();
  for (const m of (ms || []) as any[]) {
    const o = msByOrder.get(m.order_id) || {};
    o[m.step_key] = { status: m.status ?? null, due: m.due_at ? String(m.due_at).slice(0, 10) : null };
    msByOrder.set(m.order_id, o);
  }

  const today = new Date().toISOString().slice(0, 10);
  const rows: ProductionOrderRow[] = list.map((o) => {
    const m = matByOrder.get(o.id) || { total: 0, received: 0, in_transit: 0, pending: 0 };
    let status: ProductionStatus;
    if (m.total === 0) status = 'NO_MATERIALS';
    else if (m.pending > 0) status = 'BLOCKED';       // 有料未下单/未保障 → 卡
    else if (m.received === m.total) status = 'READY'; // 全部到料 → 可开
    else status = 'PARTIAL';                            // 部分在途
    const mo = msByOrder.get(o.id) || {};
    const kickoff = mo['production_kickoff'] || null;
    const completion = mo['factory_completion'] || null;
    const overdue = [kickoff, completion].some((n) => n && !DONE(n.status || '') && n.due && n.due < today);
    return {
      order_id: o.id, order_no: o.order_no, internal_order_no: o.internal_order_no, customer_name: o.customer_name,
      factory_name: o.factory_name, quantity: o.quantity, factory_date: o.factory_date ? String(o.factory_date).slice(0, 10) : null,
      etd: o.etd ? String(o.etd).slice(0, 10) : null,
      production_status: status, material: m, kickoff, completion, overdue,
    };
  })
  // 排序:BLOCKED > 逾期 > 工厂期近
  .sort((a, b) => {
    const rank = (r: ProductionOrderRow) => (r.production_status === 'BLOCKED' ? 0 : r.overdue ? 1 : r.production_status === 'READY' ? 2 : 3);
    return (rank(a) - rank(b)) || (a.factory_date || '9999').localeCompare(b.factory_date || '9999');
  });

  const summary = {
    total: rows.length,
    blocked: rows.filter((r) => r.production_status === 'BLOCKED').length,
    ready: rows.filter((r) => r.production_status === 'READY').length,
    partial: rows.filter((r) => r.production_status === 'PARTIAL').length,
    overdue: rows.filter((r) => r.overdue).length,
  };
  return { data: rows, ...( { summary } as any) };
}
