'use server';

/**
 * 延误排行榜 + 延误归因
 *
 * 目标：把"逾期完成"的历史延误捞出来分析 + 强制归因
 *   - 治理台管"活的阻塞"（actual_at IS NULL 且逾期）
 *   - 排行榜管"已过去的延误"（actual_at > due_at）
 *
 * 归因类型（delay_reason_type）:
 *   upstream        — 上游延误（供应商 / 面料 / 外部）
 *   customer_change — 客户变更（改款 / 改量 / 改交期）
 *   internal        — 内部失误（忘了点 / 沟通断链 / 排期冲突）
 *   force_majeure   — 不可抗力（疫情 / 停电 / 天灾）
 *   other           — 其他
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import { DELAY_REASON_LABEL, type DelayReasonType } from '@/lib/constants/delay-reasons';

export interface DelayedMilestoneRow {
  milestone_id: string;
  order_id: string;
  order_no: string;
  customer_name: string | null;
  step_key: string;
  due_at: string;
  actual_at: string;
  delay_days: number;
  owner_user_id: string | null;
  owner_name: string | null;
  reason_type: DelayReasonType | null;
  reason_note: string | null;
  attributed_by: string | null;
  attributed_at: string | null;
}

export interface HotspotAggregate {
  by_step: { step_key: string; count: number; total_delay_days: number; avg_delay_days: number }[];
  by_owner: { owner_user_id: string | null; owner_name: string | null; count: number; total_delay_days: number }[];
  by_reason: { reason_type: DelayReasonType | 'unattributed'; count: number }[];
  total_delayed: number;
  total_unattributed: number;
  total_delay_days_sum: number;
  avg_delay_days: number;
}

/**
 * 查询延误完成的里程碑（所有完成时 actual_at > due_at 的）
 * @param rangeDays 取近 N 天内"完成"（actual_at 落在此窗口）的记录；0 = 全部
 * @param minDelayDays 至少延误 N 天才算（过滤 0.5 天的噪声）
 */
export async function getDelayHotspots(params?: {
  rangeDays?: number;
  minDelayDays?: number;
  ownerId?: string;
  stepKey?: string;
  onlyUnattributed?: boolean;
}): Promise<{
  data?: DelayedMilestoneRow[];
  summary?: HotspotAggregate;
  error?: string;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { error: '仅管理员可访问延误排行' };

  const rangeDays = params?.rangeDays ?? 30;
  const minDelayDays = params?.minDelayDays ?? 1;

  // 1) 拉 milestones: actual_at IS NOT NULL AND actual_at > due_at
  let query = (supabase.from('milestones') as any)
    .select('id, order_id, step_key, due_at, actual_at, delay_reason_type, delay_reason_note, delay_attributed_by, delay_attributed_at')
    .not('actual_at', 'is', null)
    .not('due_at', 'is', null);

  if (rangeDays > 0) {
    const since = new Date(Date.now() - rangeDays * 86400000).toISOString();
    query = query.gte('actual_at', since);
  }

  const { data: msRaw, error: mErr } = await query;
  if (mErr) return { error: mErr.message };

  // 客户端过滤 actual_at > due_at + delay >= minDelayDays（Postgres 不好跨列比较，简单起见）
  const delayed = (msRaw || []).filter((m: any) => {
    if (!m.actual_at || !m.due_at) return false;
    const delayMs = new Date(m.actual_at).getTime() - new Date(m.due_at).getTime();
    return delayMs >= minDelayDays * 86400000;
  });

  if (delayed.length === 0) {
    return {
      data: [],
      summary: {
        by_step: [], by_owner: [], by_reason: [],
        total_delayed: 0, total_unattributed: 0, total_delay_days_sum: 0, avg_delay_days: 0,
      },
    };
  }

  // 2) 关联订单
  const orderIds = Array.from(new Set(delayed.map((m: any) => m.order_id)));
  const { data: orders } = await (supabase.from('orders') as any)
    .select('id, order_no, customer_name, owner_user_id')
    .in('id', orderIds);
  const orderMap = new Map<string, any>();
  for (const o of orders || []) orderMap.set((o as any).id, o);

  // 3) 关联负责人
  const ownerIds = Array.from(new Set((orders || []).map((o: any) => o.owner_user_id).filter(Boolean)));
  const ownerMap = new Map<string, string>();
  if (ownerIds.length) {
    const { data: profiles } = await (supabase.from('profiles') as any)
      .select('user_id, name').in('user_id', ownerIds);
    for (const p of profiles || []) ownerMap.set((p as any).user_id, (p as any).name || '');
  }

  // 4) 组装 rows
  const rows: DelayedMilestoneRow[] = delayed.map((m: any) => {
    const o = orderMap.get(m.order_id) || {};
    const delayDays = Math.floor(
      (new Date(m.actual_at).getTime() - new Date(m.due_at).getTime()) / 86400000
    );
    return {
      milestone_id: m.id,
      order_id: m.order_id,
      order_no: o.order_no || '',
      customer_name: o.customer_name || null,
      step_key: m.step_key,
      due_at: m.due_at,
      actual_at: m.actual_at,
      delay_days: delayDays,
      owner_user_id: o.owner_user_id || null,
      owner_name: o.owner_user_id ? ownerMap.get(o.owner_user_id) || null : null,
      reason_type: (m.delay_reason_type || null) as DelayReasonType | null,
      reason_note: m.delay_reason_note || null,
      attributed_by: m.delay_attributed_by || null,
      attributed_at: m.delay_attributed_at || null,
    };
  });

  // 5) 筛选
  let filtered = rows;
  if (params?.ownerId) {
    filtered = filtered.filter(r =>
      params.ownerId === '__none__' ? !r.owner_user_id : r.owner_user_id === params.ownerId
    );
  }
  if (params?.stepKey) filtered = filtered.filter(r => r.step_key === params.stepKey);
  if (params?.onlyUnattributed) filtered = filtered.filter(r => !r.reason_type);

  filtered.sort((a, b) => b.delay_days - a.delay_days);

  // 6) 聚合（基于"未筛选"的全量，避免 UI 筛选影响汇总视图）
  const byStepMap = new Map<string, { count: number; total: number }>();
  const byOwnerMap = new Map<string, { name: string | null; count: number; total: number }>();
  const byReasonMap = new Map<string, number>();
  let totalUnattributed = 0;
  let totalDelayDaysSum = 0;

  for (const r of rows) {
    totalDelayDaysSum += r.delay_days;
    if (!r.reason_type) totalUnattributed += 1;

    const stepEntry = byStepMap.get(r.step_key) || { count: 0, total: 0 };
    stepEntry.count += 1;
    stepEntry.total += r.delay_days;
    byStepMap.set(r.step_key, stepEntry);

    const oKey = r.owner_user_id || '__none__';
    const oEntry = byOwnerMap.get(oKey) || { name: r.owner_name, count: 0, total: 0 };
    oEntry.count += 1;
    oEntry.total += r.delay_days;
    byOwnerMap.set(oKey, oEntry);

    const reasonKey = r.reason_type || 'unattributed';
    byReasonMap.set(reasonKey, (byReasonMap.get(reasonKey) || 0) + 1);
  }

  const summary: HotspotAggregate = {
    by_step: Array.from(byStepMap.entries())
      .map(([step_key, v]) => ({
        step_key, count: v.count, total_delay_days: v.total,
        avg_delay_days: Math.round((v.total / v.count) * 10) / 10,
      }))
      .sort((a, b) => b.total_delay_days - a.total_delay_days),
    by_owner: Array.from(byOwnerMap.entries())
      .map(([k, v]) => ({
        owner_user_id: k === '__none__' ? null : k,
        owner_name: v.name,
        count: v.count,
        total_delay_days: v.total,
      }))
      .sort((a, b) => b.total_delay_days - a.total_delay_days),
    by_reason: Array.from(byReasonMap.entries())
      .map(([k, v]) => ({ reason_type: k as any, count: v }))
      .sort((a, b) => b.count - a.count),
    total_delayed: rows.length,
    total_unattributed: totalUnattributed,
    total_delay_days_sum: totalDelayDaysSum,
    avg_delay_days: Math.round((totalDelayDaysSum / rows.length) * 10) / 10,
  };

  return { data: filtered, summary };
}

/**
 * 提交延误归因
 * - 任何业务/跟单/采购/财务/管理员都可以归因
 * - 支持覆盖（改归因），但会记录 log
 */
export async function attributeDelay(
  milestoneId: string,
  reasonType: DelayReasonType,
  note?: string,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const VALID: DelayReasonType[] = ['upstream', 'customer_change', 'internal', 'force_majeure', 'other'];
  if (!VALID.includes(reasonType)) return { error: '无效的归因类型' };

  const { data: profile } = await supabase.from('profiles')
    .select('name, role, roles').eq('user_id', user.id).single();
  const roles: string[] = (profile as any)?.roles?.length > 0
    ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  const canAttribute = roles.some(r =>
    ['sales', 'merchandiser', 'procurement', 'finance', 'admin'].includes(r)
  );
  if (!canAttribute) return { error: '无权限归因' };

  const userName = (profile as any)?.name || user.email?.split('@')[0] || '';

  const { data: m } = await (supabase.from('milestones') as any)
    .select('id, order_id, step_key, actual_at, delay_reason_type, delay_attributed_by')
    .eq('id', milestoneId).single();
  if (!m) return { error: '关卡不存在' };
  if (!(m as any).actual_at) return { error: '该关卡尚未完成，无需归因' };

  const now = new Date().toISOString();
  const { error: updErr } = await (supabase.from('milestones') as any)
    .update({
      delay_reason_type: reasonType,
      delay_reason_note: note?.trim() || null,
      delay_attributed_by: userName,
      delay_attributed_at: now,
    })
    .eq('id', milestoneId);
  if (updErr) return { error: updErr.message };

  const wasReAttribution = !!(m as any).delay_reason_type;
  await (supabase.from('milestone_logs') as any).insert({
    milestone_id: milestoneId,
    order_id: (m as any).order_id,
    actor_user_id: user.id,
    action: wasReAttribution ? 'reattribute_delay' : 'attribute_delay',
    note: `[延误归因] ${DELAY_REASON_LABEL[reasonType]}${note ? ` — ${note}` : ''}`,
  }).catch(() => {});

  revalidatePath('/admin/delay-hotspots');
  revalidatePath(`/orders/${(m as any).order_id}`);
  return {};
}
