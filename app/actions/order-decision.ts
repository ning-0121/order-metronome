'use server';

/**
 * Order Decision Engine — Server Actions
 *
 * 安全策略：
 *   - 所有操作要求 admin 权限
 *   - feature flag ENGINE_BUSINESS_DECISION=true 时才可用
 *   - 不真阻塞 workflow（仅读/写决策记录）
 *   - override 必须同步写 decision_feedback + order_logs
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { businessDecisionEngineEnabled } from '@/lib/engine/featureFlags';
import { runOrderDecisionReview as engineRunReview } from '@/lib/engine/orderDecisionEngine';
import { upsertTask } from '@/lib/services/daily-tasks.service';
import type {
  DecisionResult,
  OrderDecisionReviewRow,
  UserAction,
  RunDecisionOptions,
  ReviewType,
} from '@/lib/types/decision';

// ─────────────────────────────────────────────────────────────
// 权限帮助函数
// ─────────────────────────────────────────────────────────────

async function requireAdmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' as const };

  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles, name, email')
    .eq('user_id', user.id)
    .single();

  const roles: string[] = profile?.roles?.length > 0
    ? profile.roles
    : [profile?.role].filter(Boolean);

  if (!roles.includes('admin')) return { error: '仅管理员可操作决策评审' as const };

  return { user, profile, supabase };
}

// ─────────────────────────────────────────────────────────────
// 内部辅助：决策结果 → 生成 daily_tasks
// ─────────────────────────────────────────────────────────────

async function generateDecisionTasks(
  supabase: any,
  orderId: string,
  reviewId: string,
  result: DecisionResult,
): Promise<void> {
  if (result.decision === 'PROCEED') return;

  // 查订单基本信息（order_no, customer_name, owner_id）
  const { data: order } = await (supabase.from('orders') as any)
    .select('order_no, customer_name, owner_id')
    .eq('id', orderId)
    .single();

  if (!order) return;

  // 查所有 admin 用户
  const { data: profiles } = await (supabase.from('profiles') as any)
    .select('user_id, role, roles');

  const adminIds: string[] = (profiles ?? [])
    .filter((p: any) => p.role === 'admin' || (Array.isArray(p.roles) && p.roles.includes('admin')))
    .map((p: any) => p.user_id as string);

  const allProfiles: any[] = profiles ?? [];

  const actionUrl = `/orders/${orderId}`;
  const today = new Date().toISOString().split('T')[0];

  if (result.decision === 'STOP') {
    // STOP → 高优先级任务给 admins + 订单负责人
    const targetIds = new Set<string>([...adminIds]);
    if (order.owner_id) targetIds.add(order.owner_id);

    for (const userId of targetIds) {
      await upsertTask(supabase, {
        assignedTo: userId,
        taskDate: today,
        taskType: 'system_alert',
        priority: 1,
        title: `🛑 决策引擎：停止推进 — ${order.order_no}`,
        description: `客户：${order.customer_name}。${result.explanation ?? ''}`.slice(0, 200),
        actionUrl,
        actionLabel: '查看决策',
        relatedOrderId: orderId,
        relatedCustomer: order.customer_name,
        sourceType: 'decision_review',
        sourceId: `${reviewId}:stop`,
      });
    }
  }

  // 每条 requiredAction → 一条 daily_task（最多 3 条）
  const actions = (result.requiredActions ?? []).slice(0, 3);
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const priority = result.decision === 'STOP' ? 1 : 2;

    // 找对应角色的用户
    const roleUsers = allProfiles
      .filter((p: any) => {
        const roleStr = action.targetRole?.toLowerCase() ?? '';
        return p.role === roleStr || (Array.isArray(p.roles) && p.roles.some((r: string) => r.toLowerCase() === roleStr));
      })
      .map((p: any) => p.user_id as string);

    const targetIds = new Set<string>([...adminIds, ...roleUsers]);

    for (const userId of targetIds) {
      await upsertTask(supabase, {
        assignedTo: userId,
        taskDate: today,
        taskType: 'system_alert',
        priority,
        title: `${result.decision === 'STOP' ? '🛑' : '⚠️'} ${action.action} — ${order.order_no}`,
        description: `客户：${order.customer_name}，责任方：${action.targetRole}`,
        actionUrl,
        actionLabel: '查看决策',
        relatedOrderId: orderId,
        relatedCustomer: order.customer_name,
        sourceType: 'decision_review',
        sourceId: `${reviewId}:action:${i}`,
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 1. 触发决策评审
// ─────────────────────────────────────────────────────────────

export async function runOrderDecisionReview(
  orderId: string,
  options: Partial<RunDecisionOptions> = {},
): Promise<{ data?: DecisionResult; error?: string }> {
  if (!businessDecisionEngineEnabled()) {
    return { error: '决策引擎尚未启用（需要管理员开启 ENGINE_BUSINESS_DECISION）' };
  }

  const auth = await requireAdmin();
  if ('error' in auth) return { error: auth.error };

  const result = await engineRunReview(auth.supabase, orderId, {
    triggeredBy: 'manual',
    reviewType: 'manual',
    ...options,
  });

  // 查最新评审 id（用于任务 dedup key）
  const { data: latestReview } = await (auth.supabase.from('order_decision_reviews') as any)
    .select('id, created_at')
    .eq('order_id', orderId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // 只有 30s 内的新评审才生成任务（避免缓存命中时重复生成）
  if (latestReview) {
    const ageMs = Date.now() - new Date(latestReview.created_at).getTime();
    if (ageMs < 30_000) {
      void generateDecisionTasks(auth.supabase, orderId, latestReview.id, result);
    }
  }

  return { data: result };
}

// ─────────────────────────────────────────────────────────────
// 2. 覆写决策（override）
// ─────────────────────────────────────────────────────────────

export async function overrideDecision(
  reviewId: string,
  userAction: 'override_to_proceed' | 'override_to_stop',
  overrideReason: string,
): Promise<{ error?: string }> {
  if (!businessDecisionEngineEnabled()) {
    return { error: '决策引擎尚未启用（需要管理员开启 ENGINE_BUSINESS_DECISION）' };
  }

  const auth = await requireAdmin();
  if ('error' in auth) return { error: auth.error };

  const { user, supabase } = auth;

  if (!overrideReason || overrideReason.trim().length < 5) {
    return { error: 'override_reason 不能为空且不少于 5 个字符' };
  }

  // 查原始评审记录（获取 order_id + 当前决策）
  const { data: review, error: fetchErr } = await (supabase.from('order_decision_reviews') as any)
    .select('id, order_id, decision, override_status')
    .eq('id', reviewId)
    .single();

  if (fetchErr || !review) return { error: '评审记录不存在' };

  const now = new Date().toISOString();
  const newDecision = userAction === 'override_to_proceed' ? 'PROCEED' : 'STOP';

  // 更新 order_decision_reviews override 字段
  const { error: updateErr } = await (supabase.from('order_decision_reviews') as any)
    .update({
      override_status: 'approved',
      override_by: user.id,
      override_reason: overrideReason.trim(),
      override_at: now,
      decision: newDecision,
      updated_at: now,
    })
    .eq('id', reviewId);

  if (updateErr) return { error: updateErr.message };

  // 写 decision_feedback（append-only）
  const { error: fbErr } = await (supabase.from('decision_feedback') as any).insert({
    decision_review_id: reviewId,
    user_action: userAction,
    override_reason: overrideReason.trim(),
    feedback_by: user.id,
  });

  if (fbErr) {
    console.error('[overrideDecision] decision_feedback insert failed:', fbErr.message);
  }

  // 写 order_logs（审计链路）
  const actionLabel = userAction === 'override_to_proceed' ? '覆写为推进' : '覆写为停止';
  await (supabase.from('order_logs') as any).insert({
    order_id: review.order_id,
    actor_id: user.id,
    action: 'decision_override',
    field_name: 'decision',
    old_value: review.decision,
    new_value: newDecision,
    note: `[决策覆写] ${actionLabel}。原因：${overrideReason.trim()}`,
  });

  revalidatePath(`/orders/${review.order_id}`);
  return {};
}

// ─────────────────────────────────────────────────────────────
// 3. 查询最新一条决策评审
// ─────────────────────────────────────────────────────────────

export async function getLatestOrderDecisionReview(
  orderId: string,
): Promise<{ data?: OrderDecisionReviewRow; error?: string }> {
  if (!businessDecisionEngineEnabled()) {
    return { error: '决策引擎尚未启用（需要管理员开启 ENGINE_BUSINESS_DECISION）' };
  }

  const auth = await requireAdmin();
  if ('error' in auth) return { error: auth.error };

  const { data, error } = await (auth.supabase.from('order_decision_reviews') as any)
    .select('*')
    .eq('order_id', orderId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return { error: error.message };
  return { data: data ?? undefined };
}

// ─────────────────────────────────────────────────────────────
// 4. 查询历史评审列表
// ─────────────────────────────────────────────────────────────

export async function getOrderDecisionHistory(
  orderId: string,
  limit = 10,
): Promise<{ data?: OrderDecisionReviewRow[]; error?: string }> {
  if (!businessDecisionEngineEnabled()) {
    return { error: '决策引擎尚未启用（需要管理员开启 ENGINE_BUSINESS_DECISION）' };
  }

  const auth = await requireAdmin();
  if ('error' in auth) return { error: auth.error };

  const { data, error } = await (auth.supabase.from('order_decision_reviews') as any)
    .select('*')
    .eq('order_id', orderId)
    .order('created_at', { ascending: false })
    .limit(Math.min(limit, 50));

  if (error) return { error: error.message };
  return { data: data ?? [] };
}

// ─────────────────────────────────────────────────────────────
// 5. 接受决策（acknowledge）
// ─────────────────────────────────────────────────────────────

export async function acceptDecision(
  reviewId: string,
): Promise<{ error?: string }> {
  if (!businessDecisionEngineEnabled()) {
    return { error: '决策引擎尚未启用' };
  }

  const auth = await requireAdmin();
  if ('error' in auth) return { error: auth.error };

  const { user, supabase } = auth;

  const { error } = await (supabase.from('decision_feedback') as any).insert({
    decision_review_id: reviewId,
    user_action: 'accept',
    feedback_by: user.id,
  });

  if (error) return { error: error.message };
  return {};
}

// ─────────────────────────────────────────────────────────────
// 6. 忽略决策（ignore）
// ─────────────────────────────────────────────────────────────

export async function ignoreDecision(
  reviewId: string,
  reason?: string,
): Promise<{ error?: string }> {
  if (!businessDecisionEngineEnabled()) {
    return { error: '决策引擎尚未启用' };
  }

  const auth = await requireAdmin();
  if ('error' in auth) return { error: auth.error };

  const { user, supabase } = auth;

  const { error } = await (supabase.from('decision_feedback') as any).insert({
    decision_review_id: reviewId,
    user_action: 'ignore',
    override_reason: reason?.trim() || null,
    feedback_by: user.id,
  });

  if (error) return { error: error.message };
  return {};
}

// ─────────────────────────────────────────────────────────────
// 7. 查询最近一条决策反馈
// ─────────────────────────────────────────────────────────────

export async function getDecisionFeedback(
  reviewId: string,
): Promise<{ data?: { user_action: string; created_at: string } | null; error?: string }> {
  if (!businessDecisionEngineEnabled()) {
    return { error: '决策引擎尚未启用' };
  }

  const auth = await requireAdmin();
  if ('error' in auth) return { error: auth.error };

  const { data, error } = await (auth.supabase.from('decision_feedback') as any)
    .select('user_action, created_at')
    .eq('decision_review_id', reviewId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return { error: error.message };
  return { data: data ?? null };
}

// ─────────────────────────────────────────────────────────────
// 8. 查询决策对应任务的处理状态
// ─────────────────────────────────────────────────────────────

export type DecisionTaskStatus =
  | { state: 'resolved' }                    // 全部完成 or feedback已确认
  | { state: 'at_risk'; escalateCount: number }  // 仍有 pending 任务

export async function getDecisionTaskStatus(
  reviewId: string,
): Promise<{ data?: DecisionTaskStatus; error?: string }> {
  if (!businessDecisionEngineEnabled()) {
    return { error: '决策引擎尚未启用' };
  }

  const auth = await requireAdmin();
  if ('error' in auth) return { error: auth.error };

  const { supabase } = auth;

  // 先查 feedback：有 accept/ignore/override 则视为已处理
  const { data: fb } = await (supabase.from('decision_feedback') as any)
    .select('user_action')
    .eq('decision_review_id', reviewId)
    .limit(1)
    .maybeSingle();

  if (fb) {
    return { data: { state: 'resolved' } };
  }

  // 查该 reviewId 对应的所有 daily_tasks（source_type='decision_review'，source_id 以 reviewId 开头）
  const { data: tasks, error } = await (supabase.from('daily_tasks') as any)
    .select('status, escalate_count, source_id')
    .eq('source_type', 'decision_review')
    .like('source_id', `${reviewId}:%`);

  if (error) return { error: error.message };
  if (!tasks || tasks.length === 0) return { data: { state: 'resolved' } };

  const hasPending = tasks.some((t: any) =>
    t.status === 'pending' || t.status === 'snoozed'
  );

  if (!hasPending) {
    return { data: { state: 'resolved' } };
  }

  const maxEscalate = Math.max(...tasks.map((t: any) => t.escalate_count ?? 0));
  return { data: { state: 'at_risk', escalateCount: maxEscalate } };
}
