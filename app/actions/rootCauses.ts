'use server';

/**
 * Root Cause Server Actions
 *
 * 安全策略：
 *   - 所有写操作要求 admin 权限（与 plan 一致）
 *   - 读操作依赖 RLS（user_can_access_order + user_can_see_financial）
 *   - feature flag 关闭时 scan/list 静默返回空
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { rootCauseEngineEnabled } from '@/lib/engine/featureFlags';
import { scanOrder } from '@/lib/engine/rootCauseEngine';
import type { RootCause, RootCauseScanResult } from '@/lib/engine/types';

async function getCurrentAdminUser() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' as const };

  const { data: profile } = await supabase
    .from('profiles').select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (profile as any)?.roles?.length > 0
    ? (profile as any).roles
    : [(profile as any)?.role].filter(Boolean);
  const isAdmin = roles.includes('admin');

  return { user, isAdmin, roles, supabase };
}

// ─────────────────────────────────────────────────────────────
// scanOrderRootCauses（admin 触发）
// ─────────────────────────────────────────────────────────────

export async function scanOrderRootCauses(orderId: string): Promise<{
  data?: RootCauseScanResult;
  error?: string;
}> {
  try {
    if (!rootCauseEngineEnabled()) {
      return { error: '根因引擎尚未启用（需要管理员开启 ENGINE_ROOT_CAUSE）' };
    }

    const auth = await getCurrentAdminUser();
    if ('error' in auth) return { error: auth.error };
    if (!auth.isAdmin) return { error: '仅管理员可触发根因扫描' };

    const result = await scanOrder(orderId, {
      source: 'rule',
      triggerUser: auth.user.id,
    });

    // 写一条 milestone_logs 留痕（扫描操作本身记录）
    try {
      await (auth.supabase.from('milestone_logs') as any).insert({
        order_id: orderId,
        actor_user_id: auth.user.id,
        action: 'root_cause_scan',
        note: `规则扫描：新建 ${result.newCauses}、更新 ${result.updatedCauses}、自动消除 ${result.resolvedCauses}`,
      });
    } catch {
      // 日志失败不影响主流程
    }

    revalidatePath(`/orders/${orderId}`);
    return { data: result };
  } catch (err: any) {
    console.error('[scanOrderRootCauses] failed:', err?.message);
    return { error: err?.message ?? '扫描失败' };
  }
}

// ─────────────────────────────────────────────────────────────
// listOrderRootCauses（任意能看订单的人，依赖 RLS）
// ─────────────────────────────────────────────────────────────

export async function listOrderRootCauses(
  orderId: string,
  opts?: { includeResolved?: boolean }
): Promise<{ data?: RootCause[]; error?: string }> {
  try {
    if (!rootCauseEngineEnabled()) return { data: [] };

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: '请先登录' };

    let query = (supabase.from('order_root_causes') as any)
      .select('*')
      .eq('order_id', orderId)
      .order('severity', { ascending: false })
      .order('created_at', { ascending: false });

    if (!opts?.includeResolved) {
      query = query.in('status', ['active', 'confirmed']);
    }

    const { data, error } = await query;
    if (error) return { error: error.message };
    return { data: (data || []) as RootCause[] };
  } catch (err: any) {
    return { error: err?.message ?? '加载失败' };
  }
}

// ─────────────────────────────────────────────────────────────
// confirmRootCause（admin 确认根因 — 表示已知晓并接受）
// ─────────────────────────────────────────────────────────────

export async function confirmRootCause(
  causeId: string,
  note?: string
): Promise<{ success?: boolean; error?: string }> {
  try {
    const auth = await getCurrentAdminUser();
    if ('error' in auth) return { error: auth.error };
    if (!auth.isAdmin) return { error: '仅管理员可确认根因' };

    const { data: existing } = await (auth.supabase.from('order_root_causes') as any)
      .select('id, order_id, cause_title, status')
      .eq('id', causeId)
      .single();
    if (!existing) return { error: '根因记录不存在' };
    if ((existing as any).status === 'resolved') return { error: '该根因已 resolved，无法再确认' };

    const { error } = await (auth.supabase.from('order_root_causes') as any)
      .update({
        status: 'confirmed',
        resolved_by: auth.user.id,
        resolution_note: note ?? null,
      })
      .eq('id', causeId);
    if (error) return { error: error.message };

    try {
      await (auth.supabase.from('milestone_logs') as any).insert({
        order_id: (existing as any).order_id,
        actor_user_id: auth.user.id,
        action: 'root_cause_confirmed',
        note: `确认根因：${(existing as any).cause_title}${note ? ' — ' + note : ''}`,
      });
    } catch {}

    revalidatePath(`/orders/${(existing as any).order_id}`);
    return { success: true };
  } catch (err: any) {
    return { error: err?.message ?? '操作失败' };
  }
}

// ─────────────────────────────────────────────────────────────
// dismissRootCause（admin 驳回根因 — 表示规则误报）
// ─────────────────────────────────────────────────────────────

export async function dismissRootCause(
  causeId: string,
  note: string
): Promise<{ success?: boolean; error?: string }> {
  try {
    if (!note || note.trim().length === 0) {
      return { error: '驳回必须填写原因（用于审计）' };
    }
    const auth = await getCurrentAdminUser();
    if ('error' in auth) return { error: auth.error };
    if (!auth.isAdmin) return { error: '仅管理员可驳回根因' };

    const { data: existing } = await (auth.supabase.from('order_root_causes') as any)
      .select('id, order_id, cause_title, status')
      .eq('id', causeId)
      .single();
    if (!existing) return { error: '根因记录不存在' };

    const { error } = await (auth.supabase.from('order_root_causes') as any)
      .update({
        status: 'dismissed',
        resolved_at: new Date().toISOString(),
        resolved_by: auth.user.id,
        resolution_note: note.trim(),
      })
      .eq('id', causeId);
    if (error) return { error: error.message };

    try {
      await (auth.supabase.from('milestone_logs') as any).insert({
        order_id: (existing as any).order_id,
        actor_user_id: auth.user.id,
        action: 'root_cause_dismissed',
        note: `驳回根因：${(existing as any).cause_title} — ${note.trim()}`,
      });
    } catch {}

    revalidatePath(`/orders/${(existing as any).order_id}`);
    return { success: true };
  } catch (err: any) {
    return { error: err?.message ?? '操作失败' };
  }
}
