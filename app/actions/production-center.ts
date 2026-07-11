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
import {
  type ProductionStage,
  DONE, RECEIVED, IN_TRANSIT, NOT_SECURED,
  computeStage, effectiveStage, STAGE_ORDER,
  KICKOFF_KEYS, FACTORY_DONE_KEYS, STAGE_SIGNAL_STEP_KEYS, pickStageSignal,
} from '@/lib/production/stage';

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
  ready_to_ship: number;
  risk: number;
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
  // production_stage_manual(20260708 迁移)未执行时降级不带该列(全按 auto 推算),否则整页变空(2026-07-08)
  const OSEL = 'id, order_no, internal_order_no, customer_name, factory_name, quantity, factory_date, etd, lifecycle_status, production_stage_manual';
  const OSEL_NO_MANUAL = 'id, order_no, internal_order_no, customer_name, factory_name, quantity, factory_date, etd, lifecycle_status';
  const runOrders = (sel: string) => {
    let q = (svc.from('orders') as any)
      .select(sel)
      .not('lifecycle_status', 'in', '("completed","已完成","cancelled","已取消","archived","已归档")');
    if (allowedIds) q = q.in('id', Array.from(allowedIds));
    return q;
  };
  let { data: orders, error: ordErr } = await runOrders(OSEL);
  if (ordErr && /production_stage_manual|column .* does not exist|schema cache/i.test(ordErr.message || '')) {
    ({ data: orders, error: ordErr } = await runOrders(OSEL_NO_MANUAL));
  }
  const list = (orders || []) as any[];
  if (list.length === 0) return { data: [], summary: emptySummary() };
  const orderIds = list.map((o) => o.id);

  // 物料就绪 + 生产节点 + 生产任务单存在性(三查并行)
  const [{ data: lines }, { data: ms }, { data: mos }] = await Promise.all([
    (svc.from('procurement_line_items') as any).select('order_id, line_status').in('order_id', orderIds),
    (svc.from('milestones') as any).select('order_id, step_key, status, due_at')
      .in('order_id', orderIds).in('step_key', STAGE_SIGNAL_STEP_KEYS),
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
    const kickoff = pickStageSignal(mo, KICKOFF_KEYS);            // V2:回落产前样确认(大货启动)
    const factoryDone = pickStageSignal(mo, FACTORY_DONE_KEYS);   // 尾查/工厂完成;V2:回落尾期验货(完工)
    const shipped = mo['shipment_execute'] || null;                                // 发货出运=出运信号(出运才离开生产中心)
    const completion = factoryDone || shipped; // 展示「工厂完成」列
    const auto = computeStage(m, kickoff, factoryDone, shipped, mo['procurement_order_placed'] || null);
    // 生产主管一次性设的手动档做「下限」:只把订单往前推,不会倒退到比手动档更早的阶段。
    const stage = effectiveStage(auto, (o.production_stage_manual as ProductionStage | 'done' | null) || null);
    if (stage === 'done') continue;   // 工厂已完工/主管标已完工,出中心
    const risk = [kickoff, completion].some((n) => n && !DONE(n.status) && n.due && n.due < today);
    rows.push({
      order_id: o.id, order_no: o.order_no, internal_order_no: o.internal_order_no, customer_name: o.customer_name,
      factory_name: o.factory_name, quantity: o.quantity,
      factory_date: o.factory_date ? String(o.factory_date).slice(0, 10) : null,
      etd: o.etd ? String(o.etd).slice(0, 10) : null,
      stage, risk, has_mo: moSet.has(o.id), material: m, kickoff, completion,
    });
  }

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
    ready_to_ship: rows.filter((r) => r.stage === 'ready_to_ship').length,
    risk: rows.filter((r) => r.risk).length,
  };
  return { data: rows, summary };
}

function emptySummary(): ProductionCenterSummary {
  return { total: 0, awaiting_procurement: 0, materials_in_transit: 0, ready_to_schedule: 0, in_production: 0, ready_to_ship: 0, risk: 0 };
}

/**
 * 导出「滞留老单核对表」(2026-07-05)——工厂期已过、仍挂活跃的订单,系统信息 + 留空下拉列,
 * 发给采购/生产逐单填真实的 采购状态/生产状态/建议处置,回收后据此批量更新(归档/完成/继续跟)。
 * 只读导出,不改任何订单。管理层(管理员/生产经理/理单/采购经理)可导。
 */
export async function exportProductionReconciliation(): Promise<{ base64?: string; fileName?: string; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!user.email?.endsWith('@qimoclothing.com')) return { error: '仅允许 @qimoclothing.com 邮箱使用本系统' };
  const { data: prof } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (prof as any)?.roles?.length > 0 ? (prof as any).roles : [(prof as any)?.role].filter(Boolean);
  if (!roles.some((r) => ['admin', 'production_manager', 'order_manager', 'procurement_manager'].includes(r))) {
    return { error: '仅管理员/生产经理/理单/采购经理可导出核对表' };
  }

  const svc = createServiceRoleClient();
  const today = new Date().toISOString().slice(0, 10);
  // 滞留候选:工厂期已过 且 仍活跃(非 完成/取消/归档/草稿/待审)
  const { data: orders } = await (svc.from('orders') as any)
    .select('id, order_no, internal_order_no, customer_name, factory_name, quantity, factory_date, etd, lifecycle_status, created_at')
    .not('lifecycle_status', 'in', '("completed","已完成","cancelled","已取消","archived","已归档","draft","pending_approval")')
    .not('factory_date', 'is', null)
    .lt('factory_date', today)
    .order('factory_date', { ascending: true });
  const list = (orders || []) as any[];
  if (list.length === 0) return { error: '没有工厂期已过的滞留订单,无需核对' };
  const orderIds = list.map((o) => o.id);

  const [{ data: lines }, { data: ms }] = await Promise.all([
    (svc.from('procurement_line_items') as any).select('order_id, line_status').in('order_id', orderIds),
    (svc.from('milestones') as any).select('order_id, step_key, status, due_at')
      .in('order_id', orderIds).in('step_key', STAGE_SIGNAL_STEP_KEYS),
  ]);
  const matByOrder = new Map<string, ProductionOrderRow['material']>();
  for (const l of (lines || []) as any[]) {
    const m = matByOrder.get(l.order_id) || { total: 0, received: 0, in_transit: 0, pending: 0 };
    m.total++;
    const st = String(l.line_status || '');
    if (RECEIVED.has(st)) m.received++; else if (NOT_SECURED.has(st)) m.pending++; else if (IN_TRANSIT.has(st)) m.in_transit++;
    matByOrder.set(l.order_id, m);
  }
  const msByOrder = new Map<string, Record<string, { status: string | null; due: string | null }>>();
  for (const m of (ms || []) as any[]) {
    const o = msByOrder.get(m.order_id) || {};
    o[m.step_key] = { status: m.status ?? null, due: m.due_at ? String(m.due_at).slice(0, 10) : null };
    msByOrder.set(m.order_id, o);
  }
  const STAGE_CN: Record<string, string> = {
    awaiting_procurement: '新订单待采购', materials_in_transit: '物料在途',
    ready_to_schedule: '开生产待排单', in_production: '生产中', ready_to_ship: '待发货', done: '工厂已完工',
  };
  const nodeCn = (n: { status: string | null; due: string | null } | null) => {
    if (!n) return '无此节点';
    const st = String(n.status || 'pending').toLowerCase();
    const label = ({ pending: '未开始', in_progress: '进行中', done: '已完成', completed: '已完成', blocked: '受阻' } as any)[st] || st;
    return `${label}${n.due ? ` (${n.due})` : ''}`;
  };
  const daysPast = (d: string) => Math.round((new Date(today).getTime() - new Date(d).getTime()) / 86400000);

  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.default.Workbook();
  const ws = wb.addWorksheet('滞留老单核对');
  const headers = [
    '订单号', '客户', '数量', '工厂', '工厂期', '逾期(天)', '系统当前阶段', '物料就绪',
    '开裁节点', '工厂完成节点',
    '采购状态【采购填】', '生产状态【生产填】', '建议处置【采购+生产】', '备注',
  ];
  ws.addRow(headers);
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  const widths = [16, 18, 10, 14, 12, 9, 16, 14, 18, 18, 20, 20, 22, 24];
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  for (const o of list) {
    const m = matByOrder.get(o.id) || { total: 0, received: 0, in_transit: 0, pending: 0 };
    const mo = msByOrder.get(o.id) || {};
    const kickoff = pickStageSignal(mo, KICKOFF_KEYS);            // V2:回落产前样确认(大货启动)
    const factoryDone = pickStageSignal(mo, FACTORY_DONE_KEYS);   // 尾查/工厂完成;V2:回落尾期验货(完工)
    const shipped = mo['shipment_execute'] || null;                                // 发货出运=出运信号(出运才离开生产中心)
    const completion = factoryDone || shipped; // 展示「工厂完成」列
    const stage = computeStage(m, kickoff, factoryDone, shipped, mo['procurement_order_placed'] || null);
    const matText = m.total === 0 ? '未起料' : `到 ${m.received}/${m.total}${m.pending > 0 ? ` · 未下单${m.pending}` : ''}`;
    ws.addRow([
      o.internal_order_no || o.order_no || o.id, o.customer_name || '', o.quantity ?? '',
      o.factory_name || '', o.factory_date ? String(o.factory_date).slice(0, 10) : '',
      o.factory_date ? daysPast(String(o.factory_date).slice(0, 10)) : '',
      STAGE_CN[stage] || stage, matText, nodeCn(kickoff), nodeCn(completion),
      '', '', '', '',
    ]);
  }

  // 下拉数据校验(采购/生产/处置列;第 2 行到末行)
  const lastRow = list.length + 1;
  const setList = (col: string, options: string) => {
    for (let r = 2; r <= lastRow; r++) {
      ws.getCell(`${col}${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${options}"`] };
    }
  };
  setList('K', '已采购完成,部分采购,未采购,无需采购');
  setList('L', '已出货,已完成待出货,生产中,未排产');
  setList('M', '归档(已完成/已出货),继续跟进,取消');

  const buffer = await wb.xlsx.writeBuffer();
  const base64 = Buffer.from(buffer as ArrayBuffer).toString('base64');
  return { base64, fileName: `滞留老单核对表_${today}_${list.length}单.xlsx` };
}
