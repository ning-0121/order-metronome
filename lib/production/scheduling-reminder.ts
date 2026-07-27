/**
 * 生产排单每日提醒(2026-07-26 CEO:A 新单待排 + B 料齐可排 + C 超时硬督办,汇成每日一条)。
 * 每天给生产主管发一条:昨日新进生产单 / 料齐可排单 / 料齐待排超时(硬督办,抄送行政督办)。
 * 只读计算 + 站内通知(+微信);经销单不排产,跳过。复用 stage.ts,与生产中心同口径。
 */

import { createServiceRoleClient } from '@/lib/supabase/server';
import { isDoneStatus } from '@/lib/domain/types';
import {
  computeStage, effectiveStage, type ProductionStage,
  RECEIVED, IN_TRANSIT, NOT_SECURED,
  KICKOFF_KEYS, FACTORY_DONE_KEYS, STAGE_SIGNAL_STEP_KEYS, pickStageSignal,
} from '@/lib/production/stage';

const OVERDUE_DAYS = 3;   // 料齐待排超过 N 天没派工 → 硬督办升级

export async function runSchedulingReminder(): Promise<{
  readyCount: number; overdueCount: number; newCount: number; notified: number;
}> {
  const svc = createServiceRoleClient();
  const { data: orders } = await (svc.from('orders') as any)
    .select('id, order_no, internal_order_no, customer_name, quantity, factory_date, etd, incoterm, lifecycle_status, production_stage_manual, order_purpose, created_at')
    .not('lifecycle_status', 'in', '("completed","已完成","cancelled","已取消","archived","已归档")');
  const list = ((orders || []) as any[]).filter((o) => (o.order_purpose || 'production') === 'production');
  if (list.length === 0) return { readyCount: 0, overdueCount: 0, newCount: 0, notified: 0 };
  const ids = list.map((o) => o.id);

  // 物料就绪 + 生产信号 + 派工记录(判"排了没")
  const matByOrder = new Map<string, { total: number; received: number; in_transit: number; pending: number }>();
  const sigByOrder = new Map<string, Record<string, { status: string | null }>>();
  const dispatched = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const slice = ids.slice(i, i + 200);
    const [{ data: lines }, { data: ms }, { data: disp }] = await Promise.all([
      (svc.from('procurement_line_items') as any).select('order_id, line_status').in('order_id', slice),
      (svc.from('milestones') as any).select('order_id, step_key, status').in('order_id', slice).in('step_key', STAGE_SIGNAL_STEP_KEYS),
      (svc.from('production_dispatch') as any).select('order_id, status').in('order_id', slice),
    ]);
    for (const l of (lines || [])) {
      const m = matByOrder.get(l.order_id) || { total: 0, received: 0, in_transit: 0, pending: 0 };
      m.total++;
      const st = String(l.line_status || '');
      if (RECEIVED.has(st)) m.received++; else if (NOT_SECURED.has(st)) m.pending++; else if (IN_TRANSIT.has(st)) m.in_transit++;
      matByOrder.set(l.order_id, m);
    }
    for (const m of (ms || [])) {
      const o = sigByOrder.get(m.order_id) || {};
      o[m.step_key] = { status: m.status ?? null };
      sigByOrder.set(m.order_id, o);
    }
    for (const d of (disp || [])) if (String(d.status || '') !== 'cancelled') dispatched.add(d.order_id);
  }

  const today = new Date().toISOString().slice(0, 10);
  const dayAgo = new Date(Date.now() - 36 * 3600 * 1000).toISOString();   // 近 36h 算"新进"
  const ready: any[] = [];      // 料齐可排(ready_to_schedule 且未派工)
  const overdue: any[] = [];    // 料齐待排超时(硬督办)
  const fresh: any[] = [];      // 昨日新进生产单

  for (const o of list) {
    if (String(o.created_at || '') >= dayAgo) fresh.push(o);
    const mat = matByOrder.get(o.id) || { total: 0, received: 0, in_transit: 0, pending: 0 };
    const sig = sigByOrder.get(o.id) || {};
    const kickoff = pickStageSignal(sig, KICKOFF_KEYS);
    const factoryDone = pickStageSignal(sig, FACTORY_DONE_KEYS);
    const shipped = sig['shipment_execute'] || null;
    const auto = computeStage(mat, kickoff, factoryDone, shipped, sig['procurement_order_placed'] || null);
    const stage = effectiveStage(auto, (o.production_stage_manual as ProductionStage | 'done' | null) || null);
    if (stage === 'ready_to_schedule' && !dispatched.has(o.id)) {
      ready.push(o);
      const keyDate = o.incoterm === 'DDP' ? o.etd : (o.factory_date || o.etd);
      const kd = keyDate ? String(keyDate).slice(0, 10) : null;
      // 硬督办:出厂日已过 / 或距出厂 ≤ OVERDUE_DAYS 天还没排
      if (kd && (kd < today || daysBetween(today, kd) <= OVERDUE_DAYS)) overdue.push(o);
    }
  }

  if (ready.length === 0 && fresh.length === 0) return { readyCount: 0, overdueCount: 0, newCount: 0, notified: 0 };

  // 收件人:全部生产主管 + admin(超时才抄送行政督办)
  const { data: profs } = await (svc.from('profiles') as any).select('user_id, role, roles');
  const rolesOf = (p: any): string[] => (p.roles?.length ? p.roles : [p.role].filter(Boolean));
  const pmIds = (profs || []).filter((p: any) => rolesOf(p).some((r: string) => ['production_manager', 'admin'].includes(r))).map((p: any) => p.user_id);
  const supervisorIds = overdue.length > 0
    ? (profs || []).filter((p: any) => rolesOf(p).some((r: string) => ['admin_assistant'].includes(r))).map((p: any) => p.user_id)
    : [];

  const no = (o: any) => o.internal_order_no || o.order_no || o.id.slice(0, 6);
  const sample = (arr: any[]) => arr.slice(0, 6).map(no).join('、') + (arr.length > 6 ? ` 等 ${arr.length} 单` : '');
  const lines: string[] = [];
  if (ready.length) lines.push(`🟢 料齐可排单:${ready.length} 单(${sample(ready)})`);
  if (overdue.length) lines.push(`🔴 料齐待排已超时/临近出厂:${overdue.length} 单(${sample(overdue)})——请优先派工`);
  if (fresh.length) lines.push(`🆕 新进生产单:${fresh.length} 单(${sample(fresh)})`);
  const title = `🏭 生产排单待办:料齐可排 ${ready.length} 单${overdue.length ? ` · ${overdue.length} 单紧急` : ''}`;
  const message = `${lines.join('\n')}\n\n到「生产中心 → 排产」派工。`;

  const rows: any[] = [];
  for (const uid of new Set([...pmIds])) rows.push(mk(uid, title, message));
  for (const uid of new Set(supervisorIds)) {
    if (pmIds.includes(uid)) continue;
    rows.push(mk(uid, `🩺 督办:${overdue.length} 单料齐待排超时`, `${overdue.length} 单料已齐却迟迟未排产(${sample(overdue)})。请督促生产主管派工。到「督办总览」看全链。`));
  }
  let notified = 0;
  if (rows.length) {
    try { await (svc.from('notifications') as any).insert(rows); notified = rows.length; }
    catch (e: any) { console.warn('[scheduling-reminder] 通知写入失败:', e?.message); }
  }
  return { readyCount: ready.length, overdueCount: overdue.length, newCount: fresh.length, notified };
}

function mk(userId: string, title: string, message: string) {
  return { user_id: userId, type: 'scheduling_reminder', title, message, related_order_id: null, status: 'unread', email_sent: false };
}
function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b + 'T00:00:00+08:00').getTime() - new Date(a + 'T00:00:00+08:00').getTime()) / 86400000);
}
