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
import { factoryMonthlyLoad, checkOverbook, monthlyLedger } from '@/lib/production/capacityLedger';

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
  const dispatchesByFactory = new Map<string, any[]>();   // 算按月产能账
  const dispatchByStyle = new Map<string, any[]>();   // key = order_id¦style_no¦color
  for (const d of (disp || [])) {
    if (d.factory_id) {
      const c = committedByFactory.get(d.factory_id) || { qty: 0, count: 0 }; c.qty += Number(d.planned_qty) || 0; c.count++; committedByFactory.set(d.factory_id, c);
      dispatchesByFactory.set(d.factory_id, [...(dispatchesByFactory.get(d.factory_id) || []), d]);
    }
    const k = `${d.order_id}¦${String(d.style_no || '')}¦${String(d.color || '')}`;
    dispatchByStyle.set(k, [...(dispatchByStyle.get(k) || []), d]);
  }
  // 每厂按月产能账(近 4 个月),给工作台展示 + 派工超卖预览
  const now = new Date();
  const fromMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const loadByFactory = new Map<string, Record<string, number>>();
  for (const f of factories) loadByFactory.set(f.id, factoryMonthlyLoad(dispatchesByFactory.get(f.id) || []));

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
    (svc.from('order_line_items') as any).select('order_id, style_no, product_name, color_cn, color_en, qty_pcs, image_url').in('order_id', orderIds),
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
    const load = loadByFactory.get(f.id) || {};
    return { factory_id: f.id, factory_name: f.factory_name, match: m, monthly_capacity: f.monthly_capacity ?? null, remaining, active_count: committedByFactory.get(f.id)?.count || 0, product_categories: f.product_categories || [], monthly_load: load, ledger: monthlyLedger(load, f.monthly_capacity, fromMonth, 4), score: rankScore(m, remaining, null) };
  }).sort((a, b) => b.score - a.score);

  const out = orderList.map((o: any) => {
    const orderCap = deriveOrderCapability({ orderPurpose: o.order_purpose, hasCustomerSupplied: custSupplied.has(o.id) });
    const req: OrderReq = { quality_grade: o.quality_grade || null, weave_type: o.weave_type || null, needs_package: o.needs_package ?? null, order_capability: orderCap };
    // 款分组
    const styleMap = new Map<string, { style_no: string; product_name: string; qty: number; colors: string[]; image_url: string | null }>();
    for (const l of (linesByOrder.get(o.id) || [])) {
      const sn = String(l.style_no || '').trim();
      const s = styleMap.get(sn) || { style_no: sn, product_name: l.product_name || '', qty: 0, colors: [] as string[], image_url: null };
      s.qty += Number(l.qty_pcs) || 0;
      if (!s.image_url && l.image_url) s.image_url = String(l.image_url);   // 同款各色存同一图,取首个非空
      const cc = String(l.color_cn || l.color_en || '').trim(); if (cc && !s.colors.includes(cc)) s.colors.push(cc);
      styleMap.set(sn, s);
    }
    const candidates = cand(req);
    const styles = [...styleMap.values()].map((s) => ({
      ...s,
      dispatches: (dispatchByStyle.get(`${o.id}¦${s.style_no}¦`) || []).concat(
        s.colors.flatMap((c) => dispatchByStyle.get(`${o.id}¦${s.style_no}¦${c}`) || [])),
    }));
    // 兜底:没有逐款明细(order_line_items)的订单,合成一条「整单」让主管仍能整单派工
    if (styles.length === 0) {
      styles.push({
        style_no: '', product_name: o.product_description || '整单', qty: o.quantity || 0, colors: [] as string[],
        dispatches: dispatchByStyle.get(`${o.id}¦¦`) || [],
      });
    }
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
export async function dispatchStyle(input: { orderId: string; styleNo: string; color?: string | null; factoryId: string; plannedQty?: number | null; start?: string | null; end?: string | null; notes?: string | null; force?: boolean }): Promise<{ ok?: boolean; error?: string; overbook?: any[] }> {
  const g = await gate(false);
  if ('error' in g) return { error: g.error };
  const { svc, userId } = g;
  const { data: fac } = await (svc.from('factories') as any).select('factory_name, monthly_capacity').eq('id', input.factoryId).maybeSingle();
  const row = {
    order_id: input.orderId, style_no: input.styleNo || null, color: input.color?.trim() || null,
    factory_id: input.factoryId, factory_name: (fac as any)?.factory_name || null,
    planned_qty: input.plannedQty != null && !isNaN(Number(input.plannedQty)) ? Number(input.plannedQty) : null,
    planned_start: input.start || null, planned_end: input.end || null, notes: input.notes?.trim() || null,
    updated_at: new Date().toISOString(),
  };
  // 同 order+style+color 已有则更新,否则插入(style_no/color 为空要用 .is(null),不能 .eq(''):整单派工 style_no=null)
  let existQ = (svc.from('production_dispatch') as any).select('id').eq('order_id', input.orderId);
  existQ = row.style_no === null ? existQ.is('style_no', null) : existQ.eq('style_no', row.style_no);
  existQ = row.color === null ? existQ.is('color', null) : existQ.eq('color', row.color);
  const { data: exist } = await existQ.maybeSingle();

  // P2 超卖拦截:该厂现有活跃派工(排除本条)按月分摊 + 本次 vs 月产能;超卖且未强制 → 挡
  if (row.planned_qty && row.planned_start && row.planned_end) {
    const { data: others } = await (svc.from('production_dispatch') as any)
      .select('id, planned_qty, planned_start, planned_end').eq('factory_id', input.factoryId).in('status', ['scheduled', 'in_production']);
    const otherRows = (others || []).filter((o: any) => o.id !== (exist as any)?.id);
    const ob = checkOverbook(factoryMonthlyLoad(otherRows), (fac as any)?.monthly_capacity, row.planned_qty, row.planned_start, row.planned_end);
    if (ob.over && !input.force) {
      const msg = ob.details.filter((d) => d.over).map((d) => `${d.month} 已派${d.committed}+本单${d.add}=${d.after} > 月产能${d.capacity}`).join('；');
      return { error: `该厂产能超卖:${msg}。请改期/换厂,或勾「仍派工」强制。`, overbook: ob.details };
    }
  }
  let error;
  if ((exist as any)?.id) ({ error } = await (svc.from('production_dispatch') as any).update(row).eq('id', (exist as any).id));
  else ({ error } = await (svc.from('production_dispatch') as any).insert({ ...row, status: 'scheduled', created_by: userId }));
  if (error) return { error: /production_dispatch|does not exist/i.test(error.message || '') ? '派工表未建:请先执行 20260712_production_scheduling_p1.sql' : error.message };
  revalidatePath('/production');
  return { ok: true };
}

/** 改派工状态 / 删派工。派工→生产中 联动点亮该单「生产启动/开裁」里程碑。 */
/** 派工投产 → 点亮该订单「生产启动/开裁」里程碑(pending→进行中)。已 gate 的调用方内部复用,不再校验。失败不阻断。 */
async function lightKickoffMilestone(svc: any, orderId: string): Promise<void> {
  try {
    const { REPORT_STEP_ALIASES } = await import('@/lib/production/stage');
    const cands = REPORT_STEP_ALIASES['production_kickoff'] || ['production_kickoff'];
    const { data: ms } = await (svc.from('milestones') as any)
      .select('id, status').eq('order_id', orderId).in('step_key', cands).limit(1).maybeSingle();
    const st = String((ms as any)?.status || '').toLowerCase();
    if ((ms as any)?.id && !['in_progress', '进行中', 'done', '已完成', 'completed', 'blocked', '阻塞'].includes(st)) {
      const { transitionMilestoneStatus } = await import('@/lib/repositories/milestonesRepo');
      await transitionMilestoneStatus((ms as any).id, '进行中', '生产排单:已派工投产,生产启动节点自动进行中');
    }
    revalidatePath(`/orders/${orderId}`);
  } catch (e: any) { console.warn('[dispatch] 里程碑联动失败(不阻断):', e?.message); }
}

export async function updateDispatchStatus(dispatchId: string, status: 'scheduled' | 'in_production' | 'done' | 'cancelled'): Promise<{ ok?: boolean; error?: string }> {
  const g = await gate(false);
  if ('error' in g) return { error: g.error };
  const { svc } = g;
  const { data: d } = await (svc.from('production_dispatch') as any).select('order_id').eq('id', dispatchId).maybeSingle();
  const { error } = await (svc.from('production_dispatch') as any).update({ status, updated_at: new Date().toISOString() }).eq('id', dispatchId);
  if (error) return { error: error.message };

  // P2 联动:派工→生产中 → 该订单「生产启动/开裁」里程碑 pending→进行中(经 stage 引擎带动生产中心阶段 + 风险卡重算)。
  if (status === 'in_production' && (d as any)?.order_id) await lightKickoffMilestone(svc, (d as any).order_id);
  revalidatePath('/production');
  return { ok: true };
}

/** P4 跟单/QC 每天录当日完成件数(增量,可负=修正)。首次录且还是「已排」→ 顺带投产联动里程碑。 */
export async function logDispatchProgress(input: { dispatchId: string; logDate: string; qtyDone: number; note?: string | null }): Promise<{ ok?: boolean; cumulative?: number; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data: prof } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (prof as any)?.roles?.length > 0 ? (prof as any).roles : [(prof as any)?.role].filter(Boolean);
  if (!roles.some((r) => ['production', 'production_manager', 'admin'].includes(r))) return { error: '仅生产/跟单/QC/主管可录生产数据' };
  if (!input.logDate) return { error: '请选日期' };
  const svc = createServiceRoleClient();
  const { data: d } = await (svc.from('production_dispatch') as any).select('id, order_id, status').eq('id', input.dispatchId).maybeSingle();
  if (!(d as any)?.id) return { error: '派工不存在' };
  const { error } = await (svc.from('production_dispatch_logs') as any).insert({
    dispatch_id: input.dispatchId, order_id: (d as any).order_id, log_date: input.logDate,
    qty_done: Math.trunc(Number(input.qtyDone) || 0), note: input.note || null, created_by: user.id,
  });
  if (error) return { error: /production_dispatch_logs|does not exist/i.test(error.message || '') ? '进度日志表未建:请先执行 20260713_production_dispatch_logs.sql' : error.message };
  // 首次录产出且还在「已排」→ 自动投产 + 点亮开裁里程碑(跟单也能触发,不再走 PM-gated 的 updateDispatchStatus)
  if ((d as any).status === 'scheduled') {
    await (svc.from('production_dispatch') as any).update({ status: 'in_production', updated_at: new Date().toISOString() }).eq('id', input.dispatchId);
    if ((d as any).order_id) await lightKickoffMilestone(svc, (d as any).order_id);
  }
  const { data: logs } = await (svc.from('production_dispatch_logs') as any).select('qty_done').eq('dispatch_id', input.dispatchId);
  const cumulative = (logs || []).reduce((s: number, l: any) => s + (Number(l.qty_done) || 0), 0);
  revalidatePath('/production');
  return { ok: true, cumulative };
}

/** P4 进度看板:在排/在产派工的计划 vs 实绩(累计完成),供跟单/QC 录数据、主管看进度。 */
export async function getProgressBoard(): Promise<{ data?: any; error?: string }> {
  const g = await gate(true);
  if ('error' in g) return { error: g.error };
  const { svc } = g;
  const { data: disp } = await (svc.from('production_dispatch') as any)
    .select('id, order_id, style_no, color, factory_name, planned_qty, planned_start, planned_end, status')
    .in('status', ['scheduled', 'in_production'])
    .order('planned_end', { ascending: true });
  const dispatches = (disp || []) as any[];
  if (dispatches.length === 0) return { data: { items: [] } };
  const ids = dispatches.map((d) => d.id);
  const orderIds = [...new Set(dispatches.map((d) => d.order_id))];
  const [{ data: logs }, { data: ords }] = await Promise.all([
    (svc.from('production_dispatch_logs') as any).select('dispatch_id, log_date, qty_done, note').in('dispatch_id', ids).order('log_date', { ascending: false }),
    (svc.from('orders') as any).select('id, order_no, internal_order_no, customer_name, factory_date').in('id', orderIds),
  ]);
  const om = new Map((ords || []).map((o: any) => [o.id, o]));
  const doneBy = new Map<string, number>();
  const recentBy = new Map<string, any[]>();
  const firstDateBy = new Map<string, string>();   // 首日录产(logs 按 log_date desc,末次覆盖=最早)
  for (const l of (logs || [])) {
    doneBy.set(l.dispatch_id, (doneBy.get(l.dispatch_id) || 0) + (Number(l.qty_done) || 0));
    const arr = recentBy.get(l.dispatch_id) || [];
    if (arr.length < 3) arr.push(l);
    recentBy.set(l.dispatch_id, arr);
    firstDateBy.set(l.dispatch_id, l.log_date);     // 遍历到该 dispatch 最早的一条时最后写入
  }
  const items = dispatches.map((d) => ({
    ...d, order: om.get(d.order_id) || null,
    done_qty: doneBy.get(d.id) || 0,
    first_log_date: firstDateBy.get(d.id) || null,
    recent_logs: recentBy.get(d.id) || [],
  }));
  return { data: { items } };
}

/** P3 工厂排产看板:按工厂看负荷账 + 名下派工(跨订单),排产冲突/大单拆多厂一眼看清。 */
export async function getFactoryScheduleBoard(): Promise<{ data?: any; error?: string }> {
  const g = await gate(true);
  if ('error' in g) return { error: g.error };
  const { svc } = g;
  const { data: facs } = await (svc.from('factories') as any)
    .select('id, factory_name, product_categories, quality_grades, weave_types, can_package, order_capabilities, monthly_capacity')
    .is('deleted_at', null).in('cooperation_status', ['active', 'trial']);
  const factories = (facs || []) as any[];
  const { data: disp } = await (svc.from('production_dispatch') as any)
    .select('id, order_id, style_no, color, factory_id, factory_name, planned_qty, planned_start, planned_end, status')
    .in('status', ['scheduled', 'in_production']);
  const dispatches = (disp || []) as any[];
  const orderIds = [...new Set(dispatches.map((d) => d.order_id))];
  const dispIds = dispatches.map((d) => d.id);
  const [{ data: ords }, { data: logs }] = await Promise.all([
    orderIds.length ? (svc.from('orders') as any).select('id, order_no, internal_order_no, customer_name, factory_date').in('id', orderIds) : Promise.resolve({ data: [] }),
    dispIds.length ? (svc.from('production_dispatch_logs') as any).select('dispatch_id, qty_done').in('dispatch_id', dispIds) : Promise.resolve({ data: [] }),
  ]);
  const orderMap = new Map((ords || []).map((o: any) => [o.id, o]));
  const doneBy = new Map<string, number>();
  for (const l of (logs || [])) doneBy.set(l.dispatch_id, (doneBy.get(l.dispatch_id) || 0) + (Number(l.qty_done) || 0));
  const now = new Date();
  const fromMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const byFactory = new Map<string, any[]>();
  for (const d of dispatches) if (d.factory_id) byFactory.set(d.factory_id, [...(byFactory.get(d.factory_id) || []), d]);

  const out = factories.map((f) => {
    const ds = (byFactory.get(f.id) || []).map((d) => ({ ...d, order: orderMap.get(d.order_id) || null, done_qty: doneBy.get(d.id) || 0 }))
      .sort((a, b) => String(a.planned_start || '').localeCompare(String(b.planned_start || '')));
    const load = factoryMonthlyLoad(ds);
    return {
      id: f.id, factory_name: f.factory_name, monthly_capacity: f.monthly_capacity ?? null,
      product_categories: f.product_categories || [], quality_grades: f.quality_grades || [], weave_types: f.weave_types || [],
      can_package: f.can_package, order_capabilities: f.order_capabilities || [],
      dispatches: ds, ledger: monthlyLedger(load, f.monthly_capacity, fromMonth, 6),
      total_committed: ds.reduce((s: number, d: any) => s + (Number(d.planned_qty) || 0), 0),
    };
  }).sort((a, b) => b.dispatches.length - a.dispatches.length);
  return { data: { factories: out } };
}

/** P3 派工单:导出某工厂名下全部派工(跨订单)为 Excel,下发工厂。 */
export async function exportFactoryDispatchSheet(factoryId: string): Promise<{ base64?: string; fileName?: string; error?: string }> {
  const g = await gate(true);
  if ('error' in g) return { error: g.error };
  const { svc } = g;
  const { data: fac } = await (svc.from('factories') as any).select('factory_name').eq('id', factoryId).maybeSingle();
  const { data: disp } = await (svc.from('production_dispatch') as any)
    .select('order_id, style_no, color, planned_qty, planned_start, planned_end, status')
    .eq('factory_id', factoryId).in('status', ['scheduled', 'in_production'])
    .order('planned_start', { ascending: true });
  const rows = (disp || []) as any[];
  if (rows.length === 0) return { error: '该工厂暂无在排派工' };
  const orderIds = [...new Set(rows.map((r) => r.order_id))];
  const { data: ords } = await (svc.from('orders') as any).select('id, order_no, internal_order_no, customer_name').in('id', orderIds);
  const om = new Map((ords || []).map((o: any) => [o.id, o]));

  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('派工单');
  ws.mergeCells('A1:H1');
  ws.getCell('A1').value = `派工单 —— ${(fac as any)?.factory_name || ''}`;
  ws.getCell('A1').font = { bold: true, size: 14 };
  const head = ws.addRow(['订单号', '客户', '款号', '颜色', '件数', '排产开始', '排产结束', '状态']);
  head.eachCell((c) => { c.font = { bold: true }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF1F5' } }; c.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } }; });
  const stCn: any = { scheduled: '已排', in_production: '生产中' };
  let total = 0;
  for (const r of rows) {
    const o = om.get(r.order_id) as any;
    total += Number(r.planned_qty) || 0;
    const row = ws.addRow([o?.internal_order_no || o?.order_no || '', o?.customer_name || '', r.style_no || '', r.color || '(整款)', r.planned_qty ?? '', r.planned_start || '', r.planned_end || '', stCn[r.status] || r.status]);
    row.eachCell((c) => { c.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } }; });
  }
  ws.addRow(['合计', '', '', '', total, '', '', '']);
  [16, 14, 16, 12, 8, 12, 12, 8].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  const buf = await wb.xlsx.writeBuffer();
  return { base64: Buffer.from(buf).toString('base64'), fileName: `派工单_${(fac as any)?.factory_name || factoryId}.xlsx` };
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
