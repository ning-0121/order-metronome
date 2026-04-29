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
