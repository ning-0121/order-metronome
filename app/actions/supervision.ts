'use server';

/**
 * 督办总览(2026-07-26 CEO:行政督导要一屏看所有单的 业务/采购/生产 三段进度 + 红黄绿)。
 * 只读、跨中心聚合:业务段=业务里程碑进度+超期;采购段=原辅料就绪度;生产段=生产中心阶段。
 * 权限:管理/督导可见(CAN_SEE_ALL_ORDERS)。写操作一律没有(督导只看不改)。
 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { hasRoleInGroup } from '@/lib/domain/roles';
import { isDoneStatus } from '@/lib/domain/types';
import {
  computeStage, effectiveStage, type ProductionStage,
  RECEIVED, IN_TRANSIT, NOT_SECURED,
  KICKOFF_KEYS, FACTORY_DONE_KEYS, STAGE_SIGNAL_STEP_KEYS, pickStageSignal,
} from '@/lib/production/stage';

export type Tone = 'green' | 'amber' | 'red' | 'grey';
export interface Segment { label: string; tone: Tone; }
export interface SupervisionRow {
  order_id: string; order_no: string | null; internal_order_no: string | null;
  customer_name: string | null; factory_name: string | null; quantity: number | null;
  factory_date: string | null;
  business: Segment; procurement: Segment; production: Segment;
  needsAttention: boolean;   // 任一段红 → 需督办
}

const BUSINESS_ROLES = new Set(['sales', 'sales_manager', 'order_manager', 'merchandiser']);
const DONE_LIFECYCLE = new Set(['completed', '已完成', 'cancelled', '已取消', 'archived', '已归档']);

export async function getSupervisionOverview(): Promise<{ rows?: SupervisionRow[]; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data: prof } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (prof as any)?.roles?.length ? (prof as any).roles : [(prof as any)?.role].filter(Boolean);
  if (!hasRoleInGroup(roles, 'CAN_SEE_ALL_ORDERS')) return { error: '仅管理/督导可查看督办总览' };

  const svc = createServiceRoleClient();
  const { data: orders } = await (svc.from('orders') as any)
    .select('id, order_no, internal_order_no, customer_name, factory_name, quantity, factory_date, etd, incoterm, lifecycle_status, production_stage_manual, order_purpose')
    .not('lifecycle_status', 'in', '("completed","已完成","cancelled","已取消","archived","已归档")');
  const list = ((orders || []) as any[]).filter((o) => (o.order_purpose || 'production') !== 'sample');
  if (list.length === 0) return { rows: [] };
  const ids = list.map((o) => o.id);

  // 全部里程碑(业务段要)+ 物料行(采购段要)
  const allMs = new Map<string, any[]>();
  const sigByOrder = new Map<string, Record<string, { status: string | null; due: string | null }>>();
  for (let i = 0; i < ids.length; i += 200) {
    const slice = ids.slice(i, i + 200);
    const { data: ms } = await (svc.from('milestones') as any)
      .select('order_id, step_key, status, due_at, owner_role').in('order_id', slice);
    for (const m of (ms || [])) {
      allMs.set(m.order_id, [...(allMs.get(m.order_id) || []), m]);
      if ((STAGE_SIGNAL_STEP_KEYS as string[]).includes(m.step_key)) {
        const o = sigByOrder.get(m.order_id) || {};
        o[m.step_key] = { status: m.status ?? null, due: m.due_at ? String(m.due_at).slice(0, 10) : null };
        sigByOrder.set(m.order_id, o);
      }
    }
  }
  const matByOrder = new Map<string, { total: number; received: number; in_transit: number; pending: number }>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data: lines } = await (svc.from('procurement_line_items') as any).select('order_id, line_status').in('order_id', ids.slice(i, i + 200));
    for (const l of (lines || [])) {
      const m = matByOrder.get(l.order_id) || { total: 0, received: 0, in_transit: 0, pending: 0 };
      m.total++;
      const st = String(l.line_status || '');
      if (RECEIVED.has(st)) m.received++; else if (NOT_SECURED.has(st)) m.pending++; else if (IN_TRANSIT.has(st)) m.in_transit++;
      matByOrder.set(l.order_id, m);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const rows: SupervisionRow[] = [];
  for (const o of list) {
    const ms = allMs.get(o.id) || [];
    const mat = matByOrder.get(o.id) || { total: 0, received: 0, in_transit: 0, pending: 0 };
    const sig = sigByOrder.get(o.id) || {};

    // 业务段:业务角色里程碑进度 + 超期
    const bms = ms.filter((m) => BUSINESS_ROLES.has(m.owner_role || ''));
    const bTotal = bms.length, bDone = bms.filter((m) => isDoneStatus(m.status)).length;
    const bOverdue = bms.some((m) => !isDoneStatus(m.status) && m.due_at && String(m.due_at).slice(0, 10) < today);
    const business: Segment = bOverdue
      ? { label: `业务超期 ${bDone}/${bTotal}`, tone: 'red' }
      : bTotal > 0 && bDone === bTotal
      ? { label: '业务完成', tone: 'green' }
      : { label: bTotal ? `业务 ${bDone}/${bTotal}` : '—', tone: bTotal ? 'amber' : 'grey' };

    // 采购段:原辅料就绪度
    const procurement: Segment = mat.total === 0
      ? { label: '无料单', tone: 'grey' }
      : mat.received === mat.total
      ? { label: '料齐', tone: 'green' }
      : (mat.received > 0 || mat.in_transit > 0)
      ? { label: `到 ${mat.received}/${mat.total}`, tone: 'amber' }
      : { label: '待采购', tone: 'red' };

    // 生产段:生产中心阶段
    const kickoff = pickStageSignal(sig, KICKOFF_KEYS);
    const factoryDone = pickStageSignal(sig, FACTORY_DONE_KEYS);
    const shipped = sig['shipment_execute'] || null;
    const auto = computeStage(mat, kickoff, factoryDone, shipped, sig['procurement_order_placed'] || null);
    const stage = effectiveStage(auto, (o.production_stage_manual as ProductionStage | 'done' | null) || null);
    const prodOverdue = [kickoff, factoryDone].some((n) => n && !isDoneStatus(n.status || '') && (n as any).due && (n as any).due < today);
    const PROD_LABEL: Record<string, { label: string; tone: Tone }> = {
      done: { label: '已完工/出运', tone: 'green' },
      ready_to_ship: { label: '待发货', tone: 'green' },
      in_production: { label: '生产中', tone: 'green' },
      ready_to_schedule: { label: '待排单', tone: 'amber' },
      materials_in_transit: { label: '料在途', tone: 'amber' },
      awaiting_procurement: { label: '待采购/未起', tone: 'red' },
    };
    const production: Segment = { ...(PROD_LABEL[stage] || { label: String(stage), tone: 'grey' as Tone }) };
    if (prodOverdue && production.tone !== 'green') production.tone = 'red';

    // 出厂日超期(业务段兜底红):关键日期已过且未完工
    const keyDate = o.incoterm === 'DDP' ? o.etd : (o.factory_date || o.etd);
    if (keyDate && String(keyDate).slice(0, 10) < today && stage !== 'done' && business.tone !== 'red') {
      business.tone = 'red'; business.label = `出厂已过 · ${business.label}`;
    }

    const needsAttention = [business, procurement, production].some((s) => s.tone === 'red');
    rows.push({
      order_id: o.id, order_no: o.order_no, internal_order_no: o.internal_order_no,
      customer_name: o.customer_name, factory_name: o.factory_name, quantity: o.quantity,
      factory_date: o.factory_date ? String(o.factory_date).slice(0, 10) : null,
      business, procurement, production, needsAttention,
    });
  }

  // 需督办的排前面,再按出厂日
  rows.sort((a, b) => {
    if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
    return String(a.factory_date || '9999').localeCompare(String(b.factory_date || '9999'));
  });
  return { rows };
}
