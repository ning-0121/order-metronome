'use server';

import { createClient } from '@/lib/supabase/server';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import { revalidatePath } from 'next/cache';
import { isDoneStatus } from '@/lib/domain/types';
import {
  AMENDMENT_RULES,
  checkAmendmentAllowed,
  type AmendmentSideEffect,
} from '@/lib/domain/amendment-policy';
import { recalcOrderMilestones } from './recalc-milestones';

/** 加载订单已完成的 step_key 集合（用于变更窗口判定） */
async function loadDoneStepKeys(supabase: any, orderId: string): Promise<Set<string>> {
  const { data } = await (supabase.from('milestones') as any)
    .select('step_key, status')
    .eq('order_id', orderId);
  const done = new Set<string>();
  for (const m of data || []) {
    if (isDoneStatus(m.status)) done.add(m.step_key);
  }
  return done;
}

/**
 * 提交订单修改申请
 */
export async function submitOrderAmendment(
  orderId: string,
  fields: Record<string, { from: string; to: string }>, // e.g. { quantity: { from: '1000', to: '1500' } }
  reason: string
): Promise<{ error?: string; success?: boolean; childOrderHint?: boolean }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  if (!reason || reason.trim().length < 5) {
    return { error: '请填写修改原因（至少5个字）' };
  }

  if (Object.keys(fields).length === 0) {
    return { error: '请至少选择一项需要修改的内容' };
  }

  // ── 服务端窗口期校验 ──
  const doneStepKeys = await loadDoneStepKeys(supabase, orderId);
  let childOrderHint = false;
  for (const key of Object.keys(fields)) {
    const { allowed, rule, reason: blocked } = checkAmendmentAllowed(key, doneStepKeys);
    if (!allowed) {
      if (rule?.fallbackToChildOrder) childOrderHint = true;
      return {
        error: `「${rule?.label || key}」当前不允许变更：${blocked || '已超过窗口期'}`,
        childOrderHint,
      };
    }
  }

  const { error } = await (supabase.from('order_amendments') as any).insert({
    order_id: orderId,
    requested_by: user.id,
    fields_to_change: fields,
    reason: reason.trim(),
    status: 'pending', // pending → approved / rejected
  });

  if (error) {
    // 如果表不存在，给出友好提示
    if (error.message?.includes('does not exist') || error.code === '42P01') {
      return { error: '修改申请功能正在初始化，请联系管理员' };
    }
    return { error: '提交失败：' + error.message };
  }

  revalidatePath(`/orders/${orderId}`);
  return { success: true };
}

/**
 * 管理员审批修改申请
 */
export async function approveOrderAmendment(
  amendmentId: string,
  approved: boolean,
  adminNote?: string
): Promise<{ error?: string; success?: boolean }> {
  const supabase = await createClient();
  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { error: '仅管理员可审批' };

  const { data: { user } } = await supabase.auth.getUser();

  const { data: amendment, error: fetchErr } = await (supabase.from('order_amendments') as any)
    .select('*')
    .eq('id', amendmentId)
    .single();

  if (fetchErr || !amendment) return { error: '申请不存在' };
  if (amendment.status !== 'pending') return { error: '此申请已处理' };

  // 更新申请状态
  await (supabase.from('order_amendments') as any)
    .update({
      status: approved ? 'approved' : 'rejected',
      reviewed_by: user!.id,
      reviewed_at: new Date().toISOString(),
      admin_note: adminNote || null,
    })
    .eq('id', amendmentId);

  // 如果批准，自动应用修改到订单 + 触发副作用 + 收集提醒
  const reminders: string[] = [];
  if (approved && amendment.fields_to_change) {
    const fieldsObj = amendment.fields_to_change as Record<string, { to: string }>;
    const updates: Record<string, any> = {};
    const sideEffects = new Set<AmendmentSideEffect>();

    for (const [field, change] of Object.entries(fieldsObj)) {
      const rule = AMENDMENT_RULES.find(r => r.field === field);
      // quantity_increase / quantity_decrease 都要写到 quantity 字段
      const dbField =
        field === 'quantity_increase' || field === 'quantity_decrease' ? 'quantity' : field;
      updates[dbField] = change.to;

      if (rule) {
        for (const eff of rule.sideEffects) sideEffects.add(eff);
        if (rule.postApprovalReminder) reminders.push(rule.postApprovalReminder);
      }
    }

    if (Object.keys(updates).length > 0) {
      await (supabase.from('orders') as any)
        .update(updates)
        .eq('id', amendment.order_id);
    }

    // ── 副作用执行 ──
    await executeSideEffects(supabase, amendment.order_id, sideEffects, user!.id, reminders);
  }

  // 把 reminders 持久化到 amendment 行（前端可读）
  if (reminders.length > 0) {
    await (supabase.from('order_amendments') as any)
      .update({ admin_note: (adminNote ? adminNote + '\n\n' : '') + reminders.join('\n\n') })
      .eq('id', amendmentId);
  }

  revalidatePath(`/orders/${amendment.order_id}`);
  return { success: true };
}

/**
 * 执行变更副作用：重算节拍器、重置节点、通知相关角色
 */
async function executeSideEffects(
  supabase: any,
  orderId: string,
  effects: Set<AmendmentSideEffect>,
  actorUserId: string,
  reminders: string[],
) {
  // 1. 重算节拍器（改交期 / 改贸易条款）
  if (effects.has('recalc_schedule')) {
    try { await recalcOrderMilestones(orderId); } catch {}
  }

  // 2. 重置「包装方式确认」节点 → in_progress + 清空 evidence
  if (effects.has('reset_packing_method_milestone')) {
    await (supabase.from('milestones') as any)
      .update({
        status: 'in_progress',
        completed_at: null,
        completed_by: null,
        notes: '⚠️ 因包装方式变更被重置 — 需重新上传包装资料',
      })
      .eq('order_id', orderId)
      .eq('step_key', 'packing_method_confirmed');
  }

  // 3. 通知相关角色
  const notifyRoles: Array<{ effect: AmendmentSideEffect; role: string; label: string }> = [
    { effect: 'notify_procurement', role: 'procurement', label: '采购' },
    { effect: 'notify_finance', role: 'finance', label: '财务' },
    { effect: 'notify_merchandiser', role: 'merchandiser', label: '跟单' },
    { effect: 'notify_production_manager', role: 'production_manager', label: '生产主管' },
  ];

  // 取订单号供通知使用
  const { data: orderRow } = await (supabase.from('orders') as any)
    .select('order_no, customer_name')
    .eq('id', orderId)
    .single();
  const orderTag = orderRow ? `${orderRow.order_no}（${orderRow.customer_name}）` : orderId;

  for (const { effect, role, label } of notifyRoles) {
    if (!effects.has(effect)) continue;
    // 找到所有该角色用户
    const { data: profiles } = await (supabase.from('profiles') as any)
      .select('user_id, role, roles');
    const targets = (profiles || []).filter((p: any) => {
      const rs: string[] = p.roles?.length > 0 ? p.roles : [p.role].filter(Boolean);
      return rs.includes(role);
    });
    for (const t of targets) {
      await (supabase.from('notifications') as any).insert({
        user_id: t.user_id,
        type: 'order_amendment',
        title: `订单变更通知（${label}）`,
        message: `订单 ${orderTag} 已批准变更，请关注后续工作${reminders.length > 0 ? '：\n' + reminders.join('\n') : ''}`,
        related_order_id: orderId,
      });
    }
  }
}

/**
 * 获取订单的修改申请列表
 */
export async function getOrderAmendments(orderId: string) {
  const supabase = await createClient();
  const { data, error } = await (supabase.from('order_amendments') as any)
    .select('*, requester:profiles!order_amendments_requested_by_fkey(name, email), reviewer:profiles!order_amendments_reviewed_by_fkey(name)')
    .eq('order_id', orderId)
    .order('created_at', { ascending: false });

  if (error) {
    // Table might not exist yet
    return { data: [], error: null };
  }
  return { data: data || [], error: null };
}

/**
 * 获取所有待审批的修改申请（管理员用）
 */
export async function getPendingAmendments() {
  const supabase = await createClient();
  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { data: [], error: '无权限' };

  const { data, error } = await (supabase.from('order_amendments') as any)
    .select('*, orders(order_no, customer_name, internal_order_no), requester:profiles!order_amendments_requested_by_fkey(name, email)')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  if (error) return { data: [], error: null };
  return { data: data || [], error: null };
}
