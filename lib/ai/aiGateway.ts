/**
 * AI Gateway — 统一 Claude 调用入口
 *
 * ══ System Consolidation Sprint 2026-04-27 ══
 *
 * 所有 Claude / Anthropic 调用**必须**从 aiGateway.run() 走。
 * 禁止在其他文件中直接 new Anthropic() 或直接 import anthropicClient
 * （旧代码过渡期间 anthropicClient.ts 暂时保留，新代码全用 aiGateway）
 *
 * 功能：
 *   - Feature Flag 短路（flag 关闭 → 立即返回 fallback）
 *   - Shadow Mode（只记录日志，不返回 AI 结果）
 *   - 统一超时（默认 30s）
 *   - Fallback 兜底（超时/失败时返回 fallback 值）
 *   - Token 用量元数据
 *   - Audit Log（console，后续接 ai_gateway_log 表）
 *   - 错误隔离（不抛异常，始终返回 GatewayResult）
 *
 * 用法：
 *   import { aiGateway } from '@/lib/ai/aiGateway';
 *
 *   const result = await aiGateway.run({
 *     task: 'email_match',
 *     system: '你是外贸助手...',
 *     input: { subject, body },
 *     timeoutMs: 30_000,
 *     fallback: null,
 *     cacheKey: `email:${emailUid}`,
 *   });
 *
 *   if (result.ok) {
 *     const parsed = result.data as MyType;
 *   }
 */

import { callClaudeJSON } from '@/lib/agent/anthropicClient';

// ── 类型定义 ──────────────────────────────────────────────────

export interface GatewayRunOptions<TFallback = null> {
  /** 任务标识符，用于日志和审计（snake_case，如 "email_match"） */
  task: string;

  /** 用户侧 input，会被序列化为 prompt 传给模型 */
  input: unknown;

  /** System prompt */
  system?: string;

  /** 超时毫秒数，默认 30000 */
  timeoutMs?: number;

  /** 失败/超时/flag关闭时返回的默认值 */
  fallback?: TFallback;

  /**
   * 缓存 key（暂时只用于 audit log 标记，后续接 ai_context_cache 表）
   * 格式建议：`${task}:${唯一标识}`
   */
  cacheKey?: string;

  /**
   * Feature Flag 函数 — 返回 false 时跳过 AI，直接返回 fallback
   * 例：() => process.env.AGENT_FLAG_EMAIL_MATCH === 'true'
   */
  featureFlag?: () => boolean;

  /**
   * Shadow Mode — true 时调用 AI 并记录日志，但返回值与 fallback 相同
   * 用于上线前的"只观察，不影响业务"阶段
   * 默认 false
   */
  shadowMode?: boolean;

  /** max_tokens，默认 1024 */
  maxTokens?: number;

  /**
   * 模型 ID，默认 claude-sonnet-4-20250514
   * 通常不需要指定
   */
  model?: string;
}

export interface GatewayResult<T = unknown> {
  ok: boolean;
  data: T | null;
  /** 失败原因：'flag_off' | 'shadow_mode' | 'timeout' | 'parse_error' | 'api_error' */
  reason?: string;
  /** Token 用量（仅 ok=true 时有值） */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheHit?: boolean;
  };
  /** 实际耗时 ms */
  durationMs: number;
}

// ── 内部 Audit Log ────────────────────────────────────────────

interface AuditEntry {
  task: string;
  cacheKey?: string;
  ok: boolean;
  reason?: string;
  durationMs: number;
  shadowMode: boolean;
  inputLength: number;
  outputLength?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheHit?: boolean;
  ts: string;
}

function writeAuditLog(entry: AuditEntry) {
  // Phase 1：console 输出。后续接 ai_gateway_log 表
  const icon = entry.ok ? '✅' : '❌';
  const shadow = entry.shadowMode ? '[shadow]' : '';
  console.log(
    `[aiGateway${shadow}] ${icon} task=${entry.task} ${entry.durationMs}ms` +
      (entry.reason ? ` reason=${entry.reason}` : '') +
      (entry.inputTokens ? ` tokens=${entry.inputTokens}+${entry.outputTokens ?? 0}` : '') +
      (entry.cacheHit ? ' 💰cache_hit' : ''),
  );
}

// ── 主调用函数 ────────────────────────────────────────────────

async function run<T = unknown, TFallback = null>(
  opts: GatewayRunOptions<TFallback>,
): Promise<GatewayResult<T | TFallback>> {
  const t0 = Date.now();
  const fallback = (opts.fallback ?? null) as TFallback;

  // ① Feature Flag 检查
  if (opts.featureFlag && !opts.featureFlag()) {
    const dur = Date.now() - t0;
    writeAuditLog({ task: opts.task, cacheKey: opts.cacheKey, ok: false, reason: 'flag_off', durationMs: dur, shadowMode: false, inputLength: 0 });
    return { ok: false, data: fallback, reason: 'flag_off', durationMs: dur };
  }

  // ② 构建 prompt
  const inputStr = typeof opts.input === 'string'
    ? opts.input
    : JSON.stringify(opts.input, null, 2);

  const shadowMode = opts.shadowMode ?? false;

  // ③ 调用 Claude
  let raw: T | null = null;
  let usage: GatewayResult['usage'] | undefined;

  try {
    raw = await callClaudeJSON<T>({
      scene: opts.task,
      system: opts.system,
      prompt: inputStr,
      timeoutMs: opts.timeoutMs ?? 30_000,
      maxTokens: opts.maxTokens ?? 1024,
      model: opts.model,
      cacheSystem: true,
    });

    // callClaudeJSON 不直接暴露 usage，暂时留 undefined；
    // 后续改为调 callClaude() 取原始结果时补充
    usage = undefined;
  } catch (err: any) {
    const dur = Date.now() - t0;
    writeAuditLog({ task: opts.task, cacheKey: opts.cacheKey, ok: false, reason: 'api_error', durationMs: dur, shadowMode, inputLength: inputStr.length });
    return { ok: false, data: fallback, reason: 'api_error', durationMs: dur };
  }

  const dur = Date.now() - t0;

  if (raw === null) {
    writeAuditLog({ task: opts.task, cacheKey: opts.cacheKey, ok: false, reason: 'timeout_or_error', durationMs: dur, shadowMode, inputLength: inputStr.length });
    return { ok: false, data: fallback, reason: 'timeout_or_error', durationMs: dur };
  }

  // ④ Shadow Mode — 记录但返回 fallback
  if (shadowMode) {
    writeAuditLog({ task: opts.task, cacheKey: opts.cacheKey, ok: true, reason: 'shadow_mode', durationMs: dur, shadowMode: true, inputLength: inputStr.length, outputLength: JSON.stringify(raw).length });
    return { ok: false, data: fallback, reason: 'shadow_mode', durationMs: dur };
  }

  writeAuditLog({ task: opts.task, cacheKey: opts.cacheKey, ok: true, durationMs: dur, shadowMode: false, inputLength: inputStr.length, outputLength: JSON.stringify(raw).length, ...usage });
  return { ok: true, data: raw as T, usage, durationMs: dur };
}

// ── 导出 ──────────────────────────────────────────────────────

export const aiGateway = { run };

/**
 * 便捷类型：从 GatewayRunOptions 推导出 data 类型
 * 用法：const result: GatewayTyped<MyType> = await aiGateway.run<MyType>({ ... })
 */
export type GatewayTyped<T> = GatewayResult<T>;
