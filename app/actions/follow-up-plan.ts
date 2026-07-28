'use server';

/**
 * 跟单计划(2026-07-27 CEO)——屏幕版日程,手机可读:「我负责的订单 × 还差哪些节点 × 各节点日期」。
 * 让每个跟单按节点做事,有明确日程。周日程导出的在线孪生;数据同源(milestones due_at + owner)。
 * 只读。默认看自己;管理层可传 ownerUserId 看某个跟单。
 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { STAGE_OF_STEP, roleLabel, statusLabel, bjDayParts } from '@/lib/exports/schedule-shared';

export interface PlanNode {
  orderId: string;
  orderNo: string;
  customer: string;
  factory: string;
  stepKey: string;
  nodeName: string;
  stage: string;
  ownerRole: string;
  dueYmd: string | null;
  dueLabel: string;   // 'MM/DD 周一' 或 '未排期'
  status: string;
  isCritical: boolean;
  overdueDays: number; // >0 逾期天数
  bucket: 'overdue' | 'today' | 'week' | 'later' | 'undated';
}

export interface FollowUpPlanResult {
  self: boolean;
  ownerName: string | null;
  people?: Array<{ user_id: string; name: string }>;  // 管理层:可切换的跟单人清单
  buckets: {
    overdue: PlanNode[];
    today: PlanNode[];
    week: PlanNode[];
    later: PlanNode[];
    undated: PlanNode[];
  };
  counts: { overdue: number; today: number; week: number; later: number; undated: number; total: number };
  error?: string;
}

const CAN_SEE_ALL = ['admin', 'production_manager', 'order_manager', 'admin_assistant'];

// 北京"今天 00:00"与"本周日 23:59"的 UTC 边界
function bjBounds() {
  const now = new Date();
  const bj = new Date(now.getTime() + 8 * 3600 * 1000);
  const y = bj.getUTCFullYear(), m = bj.getUTCMonth(), d = bj.getUTCDate();
  const todayStartUtc = Date.UTC(y, m, d) - 8 * 3600 * 1000;         // 北京今天 00:00
  const todayEndUtc = todayStartUtc + 24 * 3600 * 1000;             // 北京明天 00:00
  const dow = bj.getUTCDay();                                        // 0=周日
  const daysToSun = (7 - dow) % 7;                                   // 到本周日的天数
  const weekEndUtc = todayEndUtc + daysToSun * 24 * 3600 * 1000;    // 本周日结束(下周一 00:00)
  return { todayStartUtc, todayEndUtc, weekEndUtc, nowMs: now.getTime() };
}

export async function getFollowUpPlan(ownerUserId?: string): Promise<FollowUpPlanResult> {
  const empty: FollowUpPlanResult['buckets'] = { overdue: [], today: [], week: [], later: [], undated: [] };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { self: true, ownerName: null, buckets: empty, counts: { overdue: 0, today: 0, week: 0, later: 0, undated: 0, total: 0 }, error: '请先登录' };
  const { data: prof } = await (supabase.from('profiles') as any).select('role, roles, name').eq('user_id', user.id).single();
  const roles: string[] = (prof as any)?.roles?.length > 0 ? (prof as any).roles : [(prof as any)?.role].filter(Boolean);
  const canSeeAll = roles.some((r) => CAN_SEE_ALL.includes(r));

  const targetOwner = canSeeAll && ownerUserId ? ownerUserId : user.id;
  const self = targetOwner === user.id;

  const svc = createServiceRoleClient();

  // 管理层:给出可切换的跟单人清单(有 production/merchandiser/qc 归属节点的人)
  let people: Array<{ user_id: string; name: string }> | undefined;
  let ownerName: string | null = (prof as any)?.name || null;
  if (canSeeAll) {
    const { data: owners } = await (svc.from('milestones') as any)
      .select('owner_user_id').not('owner_user_id', 'is', null)
      .not('status', 'in', '("done","completed","已完成","cancelled","已取消")').limit(4000);
    const ids = Array.from(new Set(((owners || []) as any[]).map((o) => o.owner_user_id).filter(Boolean)));
    if (ids.length) {
      const { data: ps } = await (svc.from('profiles') as any).select('user_id, name, email').in('user_id', ids);
      people = ((ps || []) as any[]).map((p) => ({ user_id: p.user_id, name: p.name || p.email?.split('@')[0] || '未命名' }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
      if (ownerUserId) ownerName = people.find((p) => p.user_id === ownerUserId)?.name || null;
    }
  }

  const { data: ms, error } = await (svc.from('milestones') as any)
    .select('step_key, name, owner_role, due_at, status, is_critical, order_id')
    .eq('owner_user_id', targetOwner)
    .not('status', 'in', '("done","completed","已完成","cancelled","已取消")')
    .order('due_at', { ascending: true, nullsFirst: false })
    .limit(500);
  if (error) return { self, ownerName, people, buckets: empty, counts: { overdue: 0, today: 0, week: 0, later: 0, undated: 0, total: 0 }, error: `读节点失败:${error.message}` };
  const rows = (ms || []) as any[];

  // 关联订单
  const orderIds = Array.from(new Set(rows.map((r) => r.order_id)));
  const orderMap = new Map<string, any>();
  for (let i = 0; i < orderIds.length; i += 300) {
    const { data: os } = await (svc.from('orders') as any)
      .select('id, order_no, internal_order_no, customer_name, factory_name, lifecycle_status')
      .in('id', orderIds.slice(i, i + 300));
    for (const o of ((os || []) as any[])) orderMap.set(o.id, o);
  }

  const { todayStartUtc, todayEndUtc, weekEndUtc, nowMs } = bjBounds();
  const buckets = { overdue: [] as PlanNode[], today: [] as PlanNode[], week: [] as PlanNode[], later: [] as PlanNode[], undated: [] as PlanNode[] };

  for (const r of rows) {
    const o = orderMap.get(r.order_id) || {};
    // 排除已取消/已完成的订单(节点没跟着关时的兜底)
    const st = String(o.lifecycle_status || '');
    if (['cancelled', '已取消', 'completed', '已完成'].includes(st)) continue;

    let bucket: PlanNode['bucket'];
    let overdueDays = 0;
    let dueYmd: string | null = null;
    let dueLabel = '未排期';
    if (!r.due_at) {
      bucket = 'undated';
    } else {
      const t = new Date(r.due_at).getTime();
      const parts = bjDayParts(r.due_at);
      dueYmd = parts.ymd;
      dueLabel = `${parts.dateStr} ${parts.weekday}`;
      if (t < todayStartUtc) { bucket = 'overdue'; overdueDays = Math.round((nowMs - t) / 86400000); }
      else if (t < todayEndUtc) bucket = 'today';
      else if (t < weekEndUtc) bucket = 'week';
      else bucket = 'later';
    }
    buckets[bucket].push({
      orderId: r.order_id,
      orderNo: o.internal_order_no || o.order_no || '—',
      customer: o.customer_name || '—',
      factory: o.factory_name || '',
      stepKey: r.step_key,
      nodeName: r.name || r.step_key,
      stage: STAGE_OF_STEP[r.step_key] || '—',
      ownerRole: roleLabel(r.owner_role),
      dueYmd, dueLabel,
      status: statusLabel(r.status),
      isCritical: !!r.is_critical,
      overdueDays,
      bucket,
    });
  }

  const counts = {
    overdue: buckets.overdue.length, today: buckets.today.length, week: buckets.week.length,
    later: buckets.later.length, undated: buckets.undated.length,
    total: buckets.overdue.length + buckets.today.length + buckets.week.length + buckets.later.length + buckets.undated.length,
  };
  return { self, ownerName, people, buckets, counts };
}
