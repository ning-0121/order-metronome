'use server';

/**
 * Runtime Engine Phase 1 — Day 4 投影器
 *
 * 入口：recomputeDeliveryConfidence(orderId, event)
 *
 * 流程（每一步独立 try/catch，失败不影响主链路）：
 *  1. 用 service-role 客户端（bypass RLS）
 *  2. append-only 写一条 runtime_events
 *  3. 拉数据：orders + milestones + order_financials + delay_requests
 *  4. 调用 lib/runtime/deliveryConfidence.ts 纯函数
 *  5. UPSERT runtime_orders（带 version 乐观并发，冲突重试 1 次）
 *  6. 返回 { ok, data?, error? }，永不抛异常
 *
 * 不挂钩子、不改 UI、不影响任何现有业务流程。
 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import {
  runtimeProjectionEnabled,
  runtimeConfidenceVisible,
  runtimeConfidenceMode,
} from '@/lib/engine/featureFlags';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import { computeDeliveryConfidence } from '@/lib/runtime/deliveryConfidence';
import type {
  RuntimeEventType,
  RuntimeEventSeverity,
  RuntimeOrderState,
  ConfidenceComputeOutput,
} from '@/lib/runtime/types';

export interface RecomputeEventInput {
  type: RuntimeEventType;
  source?: string;
  severity?: RuntimeEventSeverity;
  payload?: Record<string, any>;
  triggeredBy?: string | null;
}

export interface RecomputeResult {
  ok: boolean;
  skipped?: boolean;             // flag 关闭时跳过
  data?: {
    eventId: string | null;
    confidence: number;
    riskLevel: string;
    explainHeadline: string;
    version: number;
  };
  error?: string;
}

const LOG_PREFIX = '[runtime-confidence]';

// ─────────────────────────────────────────────────────────────
// 主入口
// ─────────────────────────────────────────────────────────────

export async function recomputeDeliveryConfidence(
  orderId: string,
  event: RecomputeEventInput,
): Promise<RecomputeResult> {
  // 永不抛异常：所有错误都包成 { ok: false, error }
  try {
    if (!orderId) return { ok: false, error: 'orderId required' };

    // 投影开关关闭 → 跳过（仍要返回 ok，便于钩子无脑调用）
    if (!runtimeProjectionEnabled()) {
      return { ok: true, skipped: true };
    }

    let sys;
    try {
      sys = createServiceRoleClient();
    } catch (e: any) {
      console.error(LOG_PREFIX, 'service-role init failed:', e?.message);
      return { ok: false, error: 'service-role unavailable' };
    }

    // ── Step 1: append runtime_event（永远先写事件，便于事后重放）
    const eventRow = await appendEvent(sys, orderId, event);
    // 即使 event 写失败也继续算（保底交付一次重算结果给上游展示）
    const eventId = eventRow?.id || null;

    // ── Step 2: 拉数据
    const fetched = await fetchOrderRuntimeInput(sys, orderId);
    if (!fetched.ok) {
      return { ok: false, error: fetched.error };
    }

    // ── Step 3: 算
    let computed: ConfidenceComputeOutput;
    try {
      computed = computeDeliveryConfidence({
        order: fetched.order,
        milestones: fetched.milestones,
        financials: fetched.financials,
        delayRequests: fetched.delayRequests,
      });
    } catch (e: any) {
      console.error(LOG_PREFIX, 'compute failed:', e?.message);
      return { ok: false, error: 'compute exception: ' + (e?.message || 'unknown') };
    }

    // ── Step 4: UPSERT runtime_orders（乐观并发）
    const upsert = await upsertRuntimeOrder(sys, orderId, eventId, computed);
    if (!upsert.ok) {
      return { ok: false, error: upsert.error };
    }

    return {
      ok: true,
      data: {
        eventId,
        confidence: computed.confidence,
        riskLevel: computed.riskLevel,
        explainHeadline: computed.explain.headline,
        version: upsert.version,
      },
    };
  } catch (e: any) {
    console.error(LOG_PREFIX, 'top-level catch:', e?.message);
    return { ok: false, error: 'recompute exception: ' + (e?.message || 'unknown') };
  }
}

// ─────────────────────────────────────────────────────────────
// 内部：append event
// ─────────────────────────────────────────────────────────────

async function appendEvent(
  sys: any,
  orderId: string,
  event: RecomputeEventInput,
): Promise<{ id: string } | null> {
  try {
    const { data, error } = await (sys.from('runtime_events') as any)
      .insert({
        order_id: orderId,
        event_type: event.type,
        event_source: event.source ?? null,
        severity: event.severity ?? 'info',
        payload_json: event.payload ?? null,
        created_by: event.triggeredBy ?? null,
      })
      .select('id')
      .single();
    if (error) {
      console.error(LOG_PREFIX, 'event insert failed:', error.message);
      return null;
    }
    return data;
  } catch (e: any) {
    console.error(LOG_PREFIX, 'event insert exception:', e?.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// 内部：拉数据
// ─────────────────────────────────────────────────────────────

async function fetchOrderRuntimeInput(
  sys: any,
  orderId: string,
): Promise<
  | { ok: true; order: any; milestones: any[]; financials: any | null; delayRequests: any[] }
  | { ok: false; error: string }
> {
  try {
    const [orderRes, milestonesRes, financialsRes, delaysRes] = await Promise.allSettled([
      sys.from('orders').select('*').eq('id', orderId).single(),
      sys.from('milestones').select('*').eq('order_id', orderId),
      sys.from('order_financials').select('*').eq('order_id', orderId).maybeSingle(),
      sys.from('delay_requests').select('id, milestone_id, status, proposed_new_due_at, proposed_new_anchor_date').eq('order_id', orderId),
    ]);

    if (orderRes.status !== 'fulfilled' || (orderRes as any).value.error || !(orderRes as any).value.data) {
      return { ok: false, error: 'order not found: ' + orderId };
    }

    const order = (orderRes as any).value.data;
    const milestones = milestonesRes.status === 'fulfilled' ? ((milestonesRes as any).value.data || []) : [];
    const financials = financialsRes.status === 'fulfilled' ? ((financialsRes as any).value.data || null) : null;
    const delayRequests = delaysRes.status === 'fulfilled' ? ((delaysRes as any).value.data || []) : [];

    return { ok: true, order, milestones, financials, delayRequests };
  } catch (e: any) {
    return { ok: false, error: 'fetch exception: ' + (e?.message || 'unknown') };
  }
}

// ─────────────────────────────────────────────────────────────
// 内部：UPSERT 投影 + 乐观并发
// ─────────────────────────────────────────────────────────────

async function upsertRuntimeOrder(
  sys: any,
  orderId: string,
  eventId: string | null,
  computed: ConfidenceComputeOutput,
): Promise<{ ok: true; version: number } | { ok: false; error: string }> {
  const nowIso = new Date().toISOString();

  const writePayload = {
    order_id: orderId,
    delivery_confidence: computed.confidence,
    risk_level: computed.riskLevel,
    predicted_finish_date: computed.predictedFinishDate,
    buffer_days: computed.bufferDays,
    last_event_id: eventId,
    last_recomputed_at: nowIso,
    explain_json: computed.explain,
    updated_at: nowIso,
  };

  // 最多 2 次：第一次正常 update（乐观），失败则重读 + 再 update
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data: current, error: readErr } = await (sys.from('runtime_orders') as any)
      .select('version')
      .eq('order_id', orderId)
      .maybeSingle();

    if (readErr) {
      console.error(LOG_PREFIX, 'read current failed:', readErr.message);
      return { ok: false, error: 'read current failed' };
    }

    if (!current) {
      // 首次插入
      const { error: insErr } = await (sys.from('runtime_orders') as any)
        .insert({ ...writePayload, version: 1 });
      if (insErr) {
        // 并发情况下另一个进程刚插入了 → 下一轮走 update 分支
        if (attempt === 0 && /duplicate|unique|conflict/i.test(insErr.message)) continue;
        console.error(LOG_PREFIX, 'insert failed:', insErr.message);
        return { ok: false, error: 'insert failed: ' + insErr.message };
      }
      return { ok: true, version: 1 };
    }

    const expectedVersion = current.version || 0;
    const newVersion = expectedVersion + 1;

    const { data: updated, error: updErr } = await (sys.from('runtime_orders') as any)
      .update({ ...writePayload, version: newVersion })
      .eq('order_id', orderId)
      .eq('version', expectedVersion) // 乐观并发：只在 version 没变时更新
      .select('version')
      .maybeSingle();

    if (updErr) {
      console.error(LOG_PREFIX, 'update failed:', updErr.message);
      return { ok: false, error: 'update failed: ' + updErr.message };
    }

    if (updated) {
      return { ok: true, version: updated.version };
    }
    // 没有返回行 → version 已被改 → 重读重试
    console.warn(LOG_PREFIX, `version conflict on ${orderId}, attempt ${attempt + 1}, retrying`);
  }

  // 两次都冲突 — 不影响主链路，记日志后告知调用方
  console.warn(LOG_PREFIX, `version conflict persisted for ${orderId}, giving up gracefully`);
  return { ok: false, error: 'version conflict (max retries)' };
}

// ─────────────────────────────────────────────────────────────
// 工具：给上游手动 trigger / 集成测试用
// ─────────────────────────────────────────────────────────────

export async function getRuntimeOrder(
  orderId: string,
): Promise<{ data?: RuntimeOrderState; error?: string }> {
  try {
    const sys = createServiceRoleClient();
    const { data, error } = await (sys.from('runtime_orders') as any)
      .select('*')
      .eq('order_id', orderId)
      .maybeSingle();
    if (error) return { error: error.message };
    return { data: data ?? undefined };
  } catch (e: any) {
    return { error: e?.message || 'unknown' };
  }
}

/**
 * UI 显示专用 — 只读、走用户 session（RLS）、双闸：env flag + 用户身份
 *
 * 返回 null 的情况：
 *  - flag = off
 *  - flag = admin 但当前用户不是 admin
 *  - 该订单没有 runtime_orders 数据（首次没 trigger 过 / 或 RLS 不允许）
 *
 * 调用方拿到 null 应渲染老风险卡（fallback）
 */
export async function getRuntimeOrderForDisplay(
  orderId: string,
): Promise<{ data?: any; error?: string }> {
  try {
    const mode = runtimeConfidenceMode();
    if (mode === 'off') return { data: null };

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { data: null };

    // 灰度阶段：仅 admin 可见
    if (mode === 'admin') {
      const { isAdmin } = await getCurrentUserRole(supabase);
      if (!runtimeConfidenceVisible(isAdmin)) return { data: null };
    }

    // 走用户 session 读，RLS 控制可见性（admin/finance/管理助理/生产主管全量；其他只看相关订单）
    const { data, error } = await (supabase.from('runtime_orders') as any)
      .select('order_id, delivery_confidence, risk_level, predicted_finish_date, buffer_days, last_recomputed_at, explain_json, version')
      .eq('order_id', orderId)
      .maybeSingle();

    if (error) {
      console.error(LOG_PREFIX, 'display read failed:', error.message);
      return { error: error.message };
    }
    return { data: data ?? null };
  } catch (e: any) {
    console.error(LOG_PREFIX, 'display exception:', e?.message);
    return { error: e?.message || 'unknown' };
  }
}

export async function listRecentRuntimeEvents(
  orderId: string,
  limit = 20,
): Promise<{ data?: any[]; error?: string }> {
  try {
    const sys = createServiceRoleClient();
    const { data, error } = await (sys.from('runtime_events') as any)
      .select('*')
      .eq('order_id', orderId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return { error: error.message };
    return { data: data || [] };
  } catch (e: any) {
    return { error: e?.message || 'unknown' };
  }
}
