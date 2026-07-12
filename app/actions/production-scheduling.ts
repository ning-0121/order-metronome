'use server';

/**
 * 生产排单 P1:排产工作台数据 + 派工。
 * 读:生产/生产主管/理单/管理员;派工/改状态:生产主管 + 管理员。
 * 剩余产能=月产能−已派在线量;原辅料到位读采购进度;交期=orders.factory_date;订单类型派生匹配。
 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { RECEIVED } from '@/lib/production/stage';
import { deriveOrderCapability, matchFactory, rankScore, type FactoryCaps, type OrderReq } from '@/lib/production/scheduling';

async function gate(view: boolean): Promise<{ svc: any; roles: string[]; userId: string } | { error: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data: prof } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (prof as any)?.roles?.length > 0 ? (prof as any).roles : [(prof as any)?.role].filter(Boolean);
  const canView = roles.some((r) => ['production', 'production_manager', 'merchandiser', 'order_manager', 'admin'].includes(r));
  const canDispatch = roles.some((r) => ['production_manager', 'admin'].includes(r));
  if (view ? !canView : !canDispatch) return { error: view ? '无权查看排产' : '仅生产主管/管理员可排单' };
  return { svc: createServiceRoleClient(), roles, userId: user.id };
}

export async function getSchedulingBoard(): Promise<{ data?: any; error?: string }> {
  const g = await gate(true);
  if ('error' in g) return { error: g.error };
  const { svc } = g;

  // 工厂能力
  const { data: facs } = await (svc.from('factories') as any)
    .select('id, factory_name, product_categories, quality_grades, weave_types, can_package, order_capabilities, monthly_capacity')
    .is('deleted_at', null).in('cooperation_status', ['active', 'trial']);
  const factories: FactoryCaps[] = (facs || []) as any[];

  // 已派工(算工厂在线量 + 每款现状)
  const { data: disp } = await (svc.from('production_dispatch') as any)
    .select('id, order_id, style_no, color, factory_id, factory_name, planned_qty, planned_start, planned_end, status')
    .in('status', ['scheduled', 'in_production']);
  const committedByFactory = new Map<string, { qty: number; count: number }>();
  const dispatchByStyle = new Map<string, any[]>();   // key = order_id¦style_no¦color
  for (const d of (disp || [])) {
    if (d.factory_id) { const c = committedByFactory.get(d.factory_id) || { qty: 0, count: 0 }; c.qty += Number(d.planned_qty) || 0; c.count++; committedByFactory.set(d.factory_id, c); }
    const k = `${d.order_id}¦${String(d.style_no || '')}¦${String(d.color || '')}`;
    dispatchByStyle.set(k, [...(dispatchByStyle.get(k) || []), d]);
  }

  // 待排产订单:活跃(未完成/取消)、非经销(经销=买成品不排产)
  const { data: orders } = await (svc.from('orders') as any)
    .select('id, order_no, internal_order_no, customer_name, product_description, quantity, factory_date, order_purpose, quality_grade, weave_type, needs_package, factory_id, factory_name, lifecycle_status')
    .not('lifecycle_status', 'in', '("completed","已完成","cancelled","已取消","archived","已归档")')
    .order('factory_date', { ascending: true }).limit(200);
  const orderList = (orders || []).filter((o: any) => String(o.order_purpose || '').toLowerCase() !== 'trade');
  const orderIds = orderList.map((o: any) => o.id);
  if (orderIds.length === 0) return { data: { orders: [], factories } };

  // 明细(款×色)/ 客供料(委托加工判定)/ 采购到位
  const [{ data: lines }, { data: bom }, { data: pli }] = await Promise.all([
    (svc.from('order_line_items') as any).select('order_id, style_no, product_name, color_cn, color_en, qty_pcs').in('order_id', orderIds),
    (svc.from('materials_bom') as any).select('order_id, customer_supplied').in('order_id', orderIds).eq('customer_supplied', true),
    (svc.from('procurement_line_items') as any).select('order_id, line_status').in('order_id', orderIds),
  ]);
  const custSupplied = new Set<string>((bom || []).map((b: any) => b.order_id));
  const linesByOrder = new Map<string, any[]>();
  for (const l of (lines || [])) linesByOrder.set(l.order_id, [...(linesByOrder.get(l.order_id) || []), l]);
  const matByOrder = new Map<string, { total: number; ready: number }>();
  for (const p of (pli || [])) { const m = matByOrder.get(p.order_id) || { total: 0, ready: 0 }; m.total++; if (RECEIVED.has(String(p.line_status || ''))) m.ready++; matByOrder.set(p.order_id, m); }

  const cand = (req: OrderReq) => factories.map((f) => {
    const m = matchFactory(f, req);
    const committed = committedByFactory.get(f.id)?.qty || 0;
    const remaining = f.monthly_capacity != null ? (Number(f.monthly_capacity) - committed) : null;
    return { factory_id: f.id, factory_name: f.factory_name, match: m, monthly_capacity: f.monthly_capacity ?? null, remaining, active_count: committedByFactory.get(f.id)?.count || 0, product_categories: f.product_categories || [], score: rankScore(m, remaining, null) };
  }).sort((a, b) => b.score - a.score);

  const out = orderList.map((o: any) => {
    const orderCap = deriveOrderCapability({ orderPurpose: o.order_purpose, hasCustomerSupplied: custSupplied.has(o.id) });
    const req: OrderReq = { quality_grade: o.quality_grade || null, weave_type: o.weave_type || null, needs_package: o.needs_package ?? null, order_capability: orderCap };
    // 款分组
    const styleMap = new Map<string, { style_no: string; product_name: string; qty: number; colors: string[] }>();
    for (const l of (linesByOrder.get(o.id) || [])) {
      const sn = String(l.style_no || '').trim();
      const s = styleMap.get(sn) || { style_no: sn, product_name: l.product_name || '', qty: 0, colors: [] as string[] };
      s.qty += Number(l.qty_pcs) || 0;
      const cc = String(l.color_cn || l.color_en || '').trim(); if (cc && !s.colors.includes(cc)) s.colors.push(cc);
      styleMap.set(sn, s);
    }
    const candidates = cand(req);
    const styles = [...styleMap.values()].map((s) => ({
      ...s,
      dispatches: (dispatchByStyle.get(`${o.id}¦${s.style_no}¦`) || []).concat(
        s.colors.flatMap((c) => dispatchByStyle.get(`${o.id}¦${s.style_no}¦${c}`) || [])),
    }));
    const mat = matByOrder.get(o.id);
    return {
      id: o.id, order_no: o.order_no, internal_order_no: o.internal_order_no, customer_name: o.customer_name,
      product_description: o.product_description, quantity: o.quantity, factory_date: o.factory_date,
      order_capability: orderCap, quality_grade: o.quality_grade, weave_type: o.weave_type, needs_package: o.needs_package,
      material_ready_pct: mat && mat.total > 0 ? Math.round((mat.ready / mat.total) * 100) : null,
      styles, candidates: candidates.slice(0, 8),
    };
  });
  return { data: { orders: out, factories } };
}

/** 派工:款(或色)→ 工厂 + 排产窗口。upsert 同款同色。 */
export async function dispatchStyle(input: { orderId: string; styleNo: string; color?: string | null; factoryId: string; plannedQty?: number | null; start?: string | null; end?: string | null; notes?: string | null }): Promise<{ ok?: boolean; error?: string }> {
  const g = await gate(false);
  if ('error' in g) return { error: g.error };
  const { svc, userId } = g;
  const { data: fac } = await (svc.from('factories') as any).select('factory_name').eq('id', input.factoryId).maybeSingle();
  const row = {
    order_id: input.orderId, style_no: input.styleNo || null, color: input.color?.trim() || null,
    factory_id: input.factoryId, factory_name: (fac as any)?.factory_name || null,
    planned_qty: input.plannedQty != null && !isNaN(Number(input.plannedQty)) ? Number(input.plannedQty) : null,
    planned_start: input.start || null, planned_end: input.end || null, notes: input.notes?.trim() || null,
    updated_at: new Date().toISOString(),
  };
  // 同 order+style+color 已有则更新,否则插入(color 为空要用 .is(null),不能 .eq(''))
  let existQ = (svc.from('production_dispatch') as any).select('id').eq('order_id', input.orderId).eq('style_no', row.style_no);
  existQ = row.color === null ? existQ.is('color', null) : existQ.eq('color', row.color);
  const { data: exist } = await existQ.maybeSingle();
  let error;
  if ((exist as any)?.id) ({ error } = await (svc.from('production_dispatch') as any).update(row).eq('id', (exist as any).id));
  else ({ error } = await (svc.from('production_dispatch') as any).insert({ ...row, status: 'scheduled', created_by: userId }));
  if (error) return { error: /production_dispatch|does not exist/i.test(error.message || '') ? '派工表未建:请先执行 20260712_production_scheduling_p1.sql' : error.message };
  revalidatePath('/production');
  return { ok: true };
}

/** 改派工状态 / 删派工。 */
export async function updateDispatchStatus(dispatchId: string, status: 'scheduled' | 'in_production' | 'done' | 'cancelled'): Promise<{ ok?: boolean; error?: string }> {
  const g = await gate(false);
  if ('error' in g) return { error: g.error };
  const { error } = await (g.svc.from('production_dispatch') as any).update({ status, updated_at: new Date().toISOString() }).eq('id', dispatchId);
  if (error) return { error: error.message };
  revalidatePath('/production');
  return { ok: true };
}

/** 业务/主管手填订单排产要求(品质/织造/是否包装)。 */
export async function setOrderProductionAttrs(orderId: string, attrs: { quality_grade?: string | null; weave_type?: string | null; needs_package?: boolean | null }): Promise<{ ok?: boolean; error?: string }> {
  const g = await gate(true);   // view 权限即可填(生产/理单/主管/管理员)
  if ('error' in g) return { error: g.error };
  const patch: any = {};
  if (attrs.quality_grade !== undefined) patch.quality_grade = attrs.quality_grade || null;
  if (attrs.weave_type !== undefined) patch.weave_type = attrs.weave_type || null;
  if (attrs.needs_package !== undefined) patch.needs_package = attrs.needs_package;
  const { error } = await (g.svc.from('orders') as any).update(patch).eq('id', orderId);
  if (error) return { error: /quality_grade|weave_type|needs_package|does not exist/i.test(error.message || '') ? '排产字段未建:请先执行 20260712_production_scheduling_p1.sql' : error.message };
  revalidatePath('/production');
  return { ok: true };
}
