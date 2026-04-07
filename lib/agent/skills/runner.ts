/**
 * AI Skills 统一 Runner — 调度 / 缓存 / 熔断 / 日志 / 异常兜底
 *
 * 设计目标：
 *  - 任何 Skill 异常都不能影响主业务（订单详情页等）
 *  - 缓存命中时 <50ms 返回
 *  - 熔断器自动暂停反复失败的 Skill
 *  - 完整审计日志写入 ai_skill_runs
 */

import { createClient } from '@/lib/supabase/server';
import { SKILL_FLAGS } from '@/lib/agent/featureFlags';
import type {
  SkillModule,
  SkillInput,
  SkillResult,
  SkillRunOutput,
  SkillContext,
} from './types';

/** 熔断阈值 */
const CIRCUIT = {
  maxConsecutiveFailures: 5,
  pauseDurationMs: 60 * 60 * 1000, // 1h
  defaultTimeoutMs: 30_000,
};

/**
 * 跑一个 Skill — 主入口
 *
 * @returns 即使失败也不抛异常，返回 { displayResult: null, internalResult: null, ... }
 */
export async function runSkill(
  skill: SkillModule,
  input: SkillInput,
  options: { triggeredBy?: 'user' | 'cron' | 'event' | 'manual' } = {},
): Promise<SkillRunOutput> {
  const triggeredBy = options.triggeredBy || 'user';
  const isShadow = SKILL_FLAGS.shadowMode() || !!skill.forceShadow;

  // 永远不抛异常的兜底
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    const userId = user?.id;

    const ctx: SkillContext = {
      supabase,
      userId,
      isShadow,
      triggeredBy,
    };

    // 1. 熔断检查
    const broken = await isCircuitBroken(supabase, skill.name);
    if (broken) {
      return { displayResult: null, internalResult: null, cacheHit: false, circuitBroken: true };
    }

    // 2. 缓存检查
    const inputHash = skill.hashInput(input);
    if (skill.cacheTtlMs && skill.cacheTtlMs > 0) {
      const cached = await loadCachedResult(supabase, skill.name, inputHash);
      if (cached) {
        return {
          displayResult: isShadow ? null : cached.result,
          internalResult: cached.result,
          runId: cached.runId,
          cacheHit: true,
          circuitBroken: false,
        };
      }
    }

    // 3. 实际运行（带超时）
    const startTime = Date.now();
    let result: SkillResult | null = null;
    let errorMessage: string | undefined;
    let status: 'success' | 'failed' | 'timeout' = 'success';

    try {
      result = await withTimeout(skill.run(input, ctx), CIRCUIT.defaultTimeoutMs);
      // 成功 → 重置熔断器
      await resetCircuit(supabase, skill.name);
    } catch (err: any) {
      const isTimeout = err?.message === '__SKILL_TIMEOUT__';
      status = isTimeout ? 'timeout' : 'failed';
      errorMessage = isTimeout ? `Timeout ${CIRCUIT.defaultTimeoutMs}ms` : (err?.message || 'unknown');
      console.error(`[skill:${skill.name}] ${status}:`, errorMessage);
      // 失败 → 累加熔断器计数
      await incrementCircuit(supabase, skill.name, errorMessage);
    }

    const durationMs = Date.now() - startTime;

    // 4. 写日志（无论成功失败）
    const runId = await logRun(supabase, {
      skill_name: skill.name,
      order_id: input.orderId || null,
      customer_id: input.customerId || null,
      input_hash: inputHash,
      input_snapshot: input,
      output_result: result || null,
      source: result?.source || 'rules',
      confidence_score: result?.confidence ?? null,
      confidence_level: confidenceToLevel(result?.confidence),
      status: isShadow && status === 'success' ? 'shadow' : status,
      duration_ms: durationMs,
      error_message: errorMessage || null,
      is_shadow: isShadow,
      expires_at: skill.cacheTtlMs && status === 'success'
        ? new Date(Date.now() + skill.cacheTtlMs).toISOString()
        : null,
      triggered_by: triggeredBy,
      triggered_user_id: userId || null,
    });

    return {
      displayResult: isShadow || !result ? null : result,
      internalResult: result,
      runId,
      cacheHit: false,
      circuitBroken: false,
    };
  } catch (outerErr: any) {
    // 终极兜底：任何意外异常都不让 runner 抛
    console.error(`[skill:${skill.name}] runner outer error:`, outerErr?.message);
    return { displayResult: null, internalResult: null, cacheHit: false, circuitBroken: false };
  }
}

// ════════════════════════════════════════════════
// 缓存
// ════════════════════════════════════════════════

async function loadCachedResult(
  supabase: any,
  skillName: string,
  inputHash: string,
): Promise<{ result: SkillResult; runId: string } | null> {
  const { data } = await (supabase.from('ai_skill_runs') as any)
    .select('id, output_result')
    .eq('skill_name', skillName)
    .eq('input_hash', inputHash)
    .eq('status', 'success')
    .is('invalidated_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data || !data.output_result) return null;

  return {
    result: { ...(data.output_result as SkillResult), source: 'cached' },
    runId: data.id,
  };
}

/**
 * 主动失效某个订单的所有 Skill 缓存（订单变更时调用）
 */
export async function invalidateOrderSkillCache(
  orderId: string,
  skillNames?: string[],
): Promise<void> {
  try {
    const supabase = await createClient();
    let query = (supabase.from('ai_skill_runs') as any)
      .update({ invalidated_at: new Date().toISOString() })
      .eq('order_id', orderId)
      .is('invalidated_at', null);
    if (skillNames && skillNames.length > 0) {
      query = query.in('skill_name', skillNames);
    }
    await query;
  } catch (err: any) {
    console.error('[invalidateOrderSkillCache] error:', err?.message);
  }
}

// ════════════════════════════════════════════════
// 熔断器
// ════════════════════════════════════════════════

async function isCircuitBroken(supabase: any, skillName: string): Promise<boolean> {
  const { data } = await (supabase.from('ai_skill_circuit_state') as any)
    .select('paused_until')
    .eq('skill_name', skillName)
    .maybeSingle();
  if (!data || !data.paused_until) return false;
  return new Date(data.paused_until) > new Date();
}

async function incrementCircuit(supabase: any, skillName: string, reason: string): Promise<void> {
  // 读取当前
  const { data: existing } = await (supabase.from('ai_skill_circuit_state') as any)
    .select('consecutive_failures')
    .eq('skill_name', skillName)
    .maybeSingle();

  const newCount = (existing?.consecutive_failures || 0) + 1;
  const shouldPause = newCount >= CIRCUIT.maxConsecutiveFailures;
  const pausedUntil = shouldPause
    ? new Date(Date.now() + CIRCUIT.pauseDurationMs).toISOString()
    : null;

  await (supabase.from('ai_skill_circuit_state') as any)
    .upsert(
      {
        skill_name: skillName,
        consecutive_failures: newCount,
        paused_until: pausedUntil,
        last_failure_at: new Date().toISOString(),
        last_failure_message: reason.slice(0, 500),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'skill_name' },
    );
}

async function resetCircuit(supabase: any, skillName: string): Promise<void> {
  await (supabase.from('ai_skill_circuit_state') as any)
    .upsert(
      {
        skill_name: skillName,
        consecutive_failures: 0,
        paused_until: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'skill_name' },
    );
}

// ════════════════════════════════════════════════
// 日志
// ════════════════════════════════════════════════

async function logRun(supabase: any, payload: Record<string, any>): Promise<string | undefined> {
  try {
    const { data } = await (supabase.from('ai_skill_runs') as any)
      .insert(payload)
      .select('id')
      .single();
    return data?.id;
  } catch (err: any) {
    // 日志写入失败也不能影响主流程
    console.error('[skill:logRun] failed:', err?.message);
    return undefined;
  }
}

// ════════════════════════════════════════════════
// 工具函数
// ════════════════════════════════════════════════

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('__SKILL_TIMEOUT__')), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function confidenceToLevel(confidence?: number): 'high' | 'medium' | 'low' | null {
  if (confidence == null) return null;
  if (confidence >= 80) return 'high';
  if (confidence >= 50) return 'medium';
  return 'low';
}

/**
 * 简易 sha256 — 用于生成 input hash
 * 用 Web Crypto API（Node 20+ 内置）
 */
export async function sha256Hex(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const buffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
