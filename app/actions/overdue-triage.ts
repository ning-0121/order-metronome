'use server';

/**
 * 逾期订单治理台 — 按"阻塞点"聚合的逾期订单管理
 *
 * 目标：把"一个订单 N 条连锁逾期"收敛成"一个订单一个阻塞点"
 * 管理员可通过一屏动作快速处理：
 *   - 强制完成（补标 actual_at）
 *   - 转派（修改 owner_user_id）
 *   - 暂停（lifecycle_status='paused'，不再计入逾期）
 *   - 取消订单（CEO 拒绝路径复用）
 *   - 整体顺延日期（修 due_at / planned_at 偏移）
 *
 * 权限：仅 admin
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { getCurrentUserRole } from '@/lib/utils/user-role';

export interface OverdueRow {
  order_id: string;
  order_no: string;
  customer_name: string | null;
  lifecycle_status: string | null;
  owner_user_id: string | null;
  owner_name: string | null;
  // 阻塞点 = 最上游未完成关卡
  block_milestone_id: string;
  block_step_key: string;
  block_due_at: string;
  overdue_days: number;
  // 该订单未完成关卡总数（含阻塞点）
  pending_count: number;
  // 已逾期的下游关卡数（不含阻塞点）
  downstream_overdue: number;
}

export interface OverdueSummary {
  total_orders: number;
  total_overdue_rows: number;
  by_owner: { owner_user_id: string | null; owner_name: string | null; count: number }[];
  by_step_key: { step_key: string; count: number }[];
}

/**
 * 获取逾期订单治理列表
 *  - 每张订单只返回最上游未完成的逾期关卡（阻塞点）
 *  - 同时返回下游被级联影响的关卡数，便于判断严重度
 *  - 默认排除已完成 / 已取消 / 已暂停 订单
 */
export async function getOverdueTriageList(params?: {
  includeOwnerIds?: string[]; // 按负责人筛选
  onlyWithoutOwner?: boolean; // 只看未分派
  minOverdueDays?: number;    // 最少逾期天数
}): Promise<{ data?: OverdueRow[]; summary?: OverdueSummary; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { error: '仅管理员可访问治理台' };

  // 1) 拉所有 active 订单
  const ACTIVE = ['执行中', 'running', 'active', '已生效'];
  const { data: orders, error: oErr } = await (supabase.from('orders') as any)
    .select('id, order_no, customer_name, lifecycle_status, owner_user_id')
    .in('lifecycle_status', ACTIVE);
  if (oErr) return { error: oErr.message };
  if (!orders || orders.length === 0) {
    return {
      data: [],
      summary: { total_orders: 0, total_overdue_rows: 0, by_owner: [], by_step_key: [] },
    };
  }

  const orderIds = orders.map((o: any) => o.id);

  // 2) 拉这些订单的未完成里程碑（一次性）
  const { data: milestones, error: mErr } = await (supabase.from('milestones') as any)
    .select('id, order_id, step_key, due_at, actual_at')
    .in('order_id', orderIds)
    .is('actual_at', null)
    .order('due_at', { ascending: true });
  if (mErr) return { error: mErr.message };

  // 3) 拉负责人姓名（一次性）
  const ownerIds = Array.from(new Set(orders.map((o: any) => o.owner_user_id).filter(Boolean)));
  let ownerNameMap = new Map<string, string>();
  if (ownerIds.length > 0) {
    const { data: profiles } = await (supabase.from('profiles') as any)
      .select('user_id, name').in('user_id', ownerIds);
    for (const p of profiles || []) {
      ownerNameMap.set(p.user_id, p.name || '');
    }
  }

  const now = Date.now();
  const minDays = params?.minOverdueDays ?? 0;

  // 4) 按订单聚合 — 找阻塞点
  const rows: OverdueRow[] = [];
  const msByOrder = new Map<string, any[]>();
  for (const m of milestones || []) {
    if (!msByOrder.has(m.order_id)) msByOrder.set(m.order_id, []);
    msByOrder.get(m.order_id)!.push(m);
  }

  const summaryByOwner = new Map<string, { name: string | null; count: number }>();
  const summaryByStep = new Map<string, number>();
  let totalOverdueRows = 0;

  for (const o of orders) {
    const ms = msByOrder.get(o.id) || [];
    if (ms.length === 0) continue; // 全部完成

    const overdueMs = ms.filter((m: any) => m.due_at && new Date(m.due_at).getTime() < now);
    if (overdueMs.length === 0) continue; // 未逾期

    totalOverdueRows += overdueMs.length;

    // 阻塞点 = 已逾期中 due_at 最早的那个
    const block = overdueMs[0];
    const overdueDays = Math.floor((now - new Date(block.due_at).getTime()) / 86400000);
    if (overdueDays < minDays) continue;

    // 筛选条件
    if (params?.onlyWithoutOwner && o.owner_user_id) continue;
    if (params?.includeOwnerIds?.length && !params.includeOwnerIds.includes(o.owner_user_id || '')) continue;

    rows.push({
      order_id: o.id,
      order_no: o.order_no,
      customer_name: o.customer_name,
      lifecycle_status: o.lifecycle_status,
      owner_user_id: o.owner_user_id,
      owner_name: o.owner_user_id ? ownerNameMap.get(o.owner_user_id) || null : null,
      block_milestone_id: block.id,
      block_step_key: block.step_key,
      block_due_at: block.due_at,
      overdue_days: overdueDays,
      pending_count: ms.length,
      downstream_overdue: overdueMs.length - 1,
    });

    // 汇总
    const ownerKey = o.owner_user_id || '__none__';
    const ownerEntry = summaryByOwner.get(ownerKey) || {
      name: o.owner_user_id ? ownerNameMap.get(o.owner_user_id) || null : null,
      count: 0,
    };
    ownerEntry.count += 1;
    summaryByOwner.set(ownerKey, ownerEntry);

    summaryByStep.set(block.step_key, (summaryByStep.get(block.step_key) || 0) + 1);
  }

  // 按逾期天数降序
  rows.sort((a, b) => b.overdue_days - a.overdue_days);

  const summary: OverdueSummary = {
    total_orders: rows.length,
    total_overdue_rows: totalOverdueRows,
    by_owner: Array.from(summaryByOwner.entries())
      .map(([k, v]) => ({
        owner_user_id: k === '__none__' ? null : k,
        owner_name: v.name,
        count: v.count,
      }))
      .sort((a, b) => b.count - a.count),
    by_step_key: Array.from(summaryByStep.entries())
      .map(([k, v]) => ({ step_key: k, count: v }))
      .sort((a, b) => b.count - a.count),
  };

  return { data: rows, summary };
}

/**
 * 强制完成阻塞点关卡
 * - 用 admin 权限补标 actual_at，推动订单继续前进
 * - 写审计日志
 */
export async function forceCompleteBlockMilestone(
  milestoneId: string,
  note: string,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { error: '仅管理员可强制完成关卡' };

  if (!note?.trim()) return { error: '请填写强制完成原因（审计用）' };

  const { data: m } = await (supabase.from('milestones') as any)
    .select('id, order_id, step_key, actual_at').eq('id', milestoneId).single();
  if (!m) return { error: '关卡不存在' };
  if ((m as any).actual_at) return { error: '该关卡已完成' };

  const now = new Date().toISOString();
  const { error: updErr } = await (supabase.from('milestones') as any)
    .update({ status: 'done', actual_at: now, updated_at: now })
    .eq('id', milestoneId);
  if (updErr) return { error: updErr.message };

  await (supabase.from('milestone_logs') as any).insert({
    milestone_id: milestoneId,
    order_id: (m as any).order_id,
    actor_user_id: user.id,
    action: 'force_complete_block',
    note: `[治理台强制完成] ${note.trim()}`,
  }).catch(() => {});

  revalidatePath(`/orders/${(m as any).order_id}`);
  revalidatePath('/admin/overdue');
  return {};
}

/**
 * 转派订单负责人
 * - 修改 owner_user_id
 * - 通知新负责人
 * - 写审计
 */
export async function transferOrderOwner(
  orderId: string,
  newOwnerUserId: string,
  reason: string,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { error: '仅管理员可转派' };

  if (!newOwnerUserId) return { error: '请选择新负责人' };
  if (!reason?.trim()) return { error: '请填写转派原因（审计用）' };

  const { data: order } = await (supabase.from('orders') as any)
    .select('id, order_no, owner_user_id').eq('id', orderId).single();
  if (!order) return { error: '订单不存在' };

  const { data: newProfile } = await (supabase.from('profiles') as any)
    .select('user_id, name').eq('user_id', newOwnerUserId).single();
  if (!newProfile) return { error: '新负责人不存在' };

  const { error: updErr } = await (supabase.from('orders') as any)
    .update({ owner_user_id: newOwnerUserId, updated_at: new Date().toISOString() })
    .eq('id', orderId);
  if (updErr) return { error: updErr.message };

  // 审计（复用 milestone_logs，order_id 非 null 即可）
  await (supabase.from('milestone_logs') as any).insert({
    order_id: orderId,
    actor_user_id: user.id,
    action: 'transfer_owner',
    note: `[治理台转派] 原负责人 → ${(newProfile as any).name}。原因：${reason.trim()}`,
  }).catch(() => {});

  // 通知新负责人
  await (supabase.from('notifications') as any).insert({
    user_id: newOwnerUserId,
    type: 'order_transferred',
    title: `🔄 订单已转派给你 — ${(order as any).order_no}`,
    message: `管理员将订单 ${(order as any).order_no} 转派给你。\n原因：${reason.trim()}\n请尽快处理。`,
    related_order_id: orderId,
    status: 'unread',
  }).catch(() => {});

  revalidatePath(`/orders/${orderId}`);
  revalidatePath('/admin/overdue');
  return {};
}

/**
 * 暂停订单 — 不计入逾期
 * - lifecycle_status → 'paused'
 * - 典型场景：客户还在谈、等外部条件
 */
export async function pauseOverdueOrder(
  orderId: string,
  reason: string,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { error: '仅管理员可暂停订单' };

  if (!reason?.trim()) return { error: '请填写暂停原因（审计用）' };

  const { data: order } = await (supabase.from('orders') as any)
    .select('id, order_no, notes').eq('id', orderId).single();
  if (!order) return { error: '订单不存在' };

  const appendedNote = `${(order as any).notes || ''}\n\n[${new Date().toISOString().slice(0, 10)} 治理台暂停] ${reason.trim()}`.trim();

  const { error: updErr } = await (supabase.from('orders') as any)
    .update({ lifecycle_status: 'paused', notes: appendedNote, updated_at: new Date().toISOString() })
    .eq('id', orderId);
  if (updErr) return { error: updErr.message };

  await (supabase.from('milestone_logs') as any).insert({
    order_id: orderId,
    actor_user_id: user.id,
    action: 'pause_order',
    note: `[治理台暂停] ${reason.trim()}`,
  }).catch(() => {});

  revalidatePath(`/orders/${orderId}`);
  revalidatePath('/admin/overdue');
  return {};
}

/** 恢复已暂停订单 */
export async function resumeOverdueOrder(orderId: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { error: '仅管理员可恢复订单' };

  const { error } = await (supabase.from('orders') as any)
    .update({ lifecycle_status: 'active', updated_at: new Date().toISOString() })
    .eq('id', orderId);
  if (error) return { error: error.message };

  await (supabase.from('milestone_logs') as any).insert({
    order_id: orderId,
    actor_user_id: user.id,
    action: 'resume_order',
    note: '[治理台] 恢复执行',
  }).catch(() => {});

  revalidatePath('/admin/overdue');
  return {};
}

/**
 * 整体顺延订单 — 把所有未完成关卡的 due_at / planned_at 后移 N 天
 * - 典型场景：模板日期锚错了（例如 QM-20260418-005）
 * - 不触碰已完成关卡
 */
export async function shiftOrderSchedule(
  orderId: string,
  shiftDays: number,
  reason: string,
): Promise<{ error?: string; shifted_count?: number }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { error: '仅管理员可调整订单排期' };

  if (!Number.isFinite(shiftDays) || shiftDays === 0) return { error: '请输入非零偏移天数' };
  if (Math.abs(shiftDays) > 365) return { error: '偏移天数过大（±365 天以内）' };
  if (!reason?.trim()) return { error: '请填写调整原因（审计用）' };

  const { data: ms } = await (supabase.from('milestones') as any)
    .select('id, due_at, planned_at, actual_at')
    .eq('order_id', orderId)
    .is('actual_at', null);
  if (!ms || ms.length === 0) return { error: '没有可调整的未完成关卡' };

  const addMs = shiftDays * 86400000;
  let count = 0;
  for (const m of ms) {
    const updates: any = { updated_at: new Date().toISOString() };
    if ((m as any).due_at) {
      updates.due_at = new Date(new Date((m as any).due_at).getTime() + addMs).toISOString();
    }
    if ((m as any).planned_at) {
      updates.planned_at = new Date(new Date((m as any).planned_at).getTime() + addMs).toISOString();
    }
    const { error } = await (supabase.from('milestones') as any)
      .update(updates).eq('id', (m as any).id);
    if (!error) count += 1;
  }

  await (supabase.from('milestone_logs') as any).insert({
    order_id: orderId,
    actor_user_id: user.id,
    action: 'shift_schedule',
    note: `[治理台顺延 ${shiftDays} 天] ${reason.trim()}`,
  }).catch(() => {});

  revalidatePath(`/orders/${orderId}`);
  revalidatePath('/admin/overdue');
  return { shifted_count: count };
}

/** 获取可转派的候选用户（业务/跟单/采购/管理员）*/
export async function getTransferCandidates(): Promise<{
  data?: { user_id: string; name: string; role: string }[];
  error?: string;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { error: '无权限' };

  const { data } = await (supabase.from('profiles') as any)
    .select('user_id, name, role, roles')
    .order('name', { ascending: true });

  const allowed = ['sales', 'merchandiser', 'procurement', 'admin'];
  const rows = (data || [])
    .filter((p: any) => {
      const roles: string[] = p.roles?.length > 0 ? p.roles : [p.role].filter(Boolean);
      return roles.some(r => allowed.includes(r));
    })
    .map((p: any) => ({
      user_id: p.user_id,
      name: p.name || '—',
      role: (p.roles?.[0] || p.role || '') as string,
    }));

  return { data: rows };
}
