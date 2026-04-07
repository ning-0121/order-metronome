/**
 * Anthropic SDK 共享封装 — 强制超时 + 错误降级
 *
 * 背景（2026-04-07 P1 修复）：
 * 之前 Agent 各处直接 `new Anthropic()` + `client.messages.create()`，
 * 一旦 Claude API 响应慢/挂起，整个 Vercel 函数会被拖到 60s 上限被强杀，
 * 导致 cron 作业完全失败。
 *
 * 这个封装强制：
 *  - 默认 30s 超时（通过 AbortController）
 *  - 失败时返回 null（不抛异常），调用方决定是否降级
 *  - 统一日志格式便于排查
 *
 * 用法：
 *   import { callClaudeJSON } from '@/lib/agent/anthropicClient';
 *   const result = await callClaudeJSON({
 *     scene: 'po-verify',
 *     prompt: '...',
 *     model: 'claude-sonnet-4-20250514',
 *     maxTokens: 1024,
 *     timeoutMs: 30000,
 *   });
 */

import Anthropic from '@anthropic-ai/sdk';

export interface ClaudeCallOptions {
  /** 调用场景标识，用于日志 */
  scene: string;
  /** Prompt 文本 — 普通文本 prompt 用 user message */
  prompt?: string;
  /** 完整 messages 数组 — 用于多轮/多模态 */
  messages?: Anthropic.MessageParam[];
  /** System prompt（可选） */
  system?: string;
  /** 模型 ID，默认 sonnet */
  model?: string;
  /** max_tokens，默认 1024 */
  maxTokens?: number;
  /** 超时毫秒，默认 30s */
  timeoutMs?: number;
}

export interface ClaudeRawResult {
  text: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * 调用 Claude 并返回纯文本结果
 * 失败 / 超时 / 无 API key 都返回 null（不抛异常）
 */
export async function callClaude(opts: ClaudeCallOptions): Promise<ClaudeRawResult | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn(`[claude:${opts.scene}] ANTHROPIC_API_KEY not set, skip`);
    return null;
  }

  const timeoutMs = opts.timeoutMs ?? 30_000;
  const model = opts.model ?? 'claude-sonnet-4-20250514';
  const maxTokens = opts.maxTokens ?? 1024;

  // Anthropic SDK 支持 signal 参数做超时
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const client = new Anthropic({ apiKey });
    const messages: Anthropic.MessageParam[] = opts.messages
      ? opts.messages
      : opts.prompt
        ? [{ role: 'user', content: opts.prompt }]
        : [];

    if (messages.length === 0) {
      console.warn(`[claude:${opts.scene}] no prompt/messages provided`);
      return null;
    }

    const response = await client.messages.create(
      {
        model,
        max_tokens: maxTokens,
        ...(opts.system ? { system: opts.system } : {}),
        messages,
      },
      { signal: controller.signal },
    );

    const text = response.content
      .filter(block => block.type === 'text')
      .map(block => (block as Anthropic.TextBlock).text)
      .join('');

    return {
      text,
      usage: {
        input_tokens: response.usage?.input_tokens,
        output_tokens: response.usage?.output_tokens,
      },
    };
  } catch (err: any) {
    if (err?.name === 'AbortError' || err?.message?.includes('aborted')) {
      console.error(`[claude:${opts.scene}] TIMEOUT after ${timeoutMs}ms`);
    } else {
      console.error(`[claude:${opts.scene}] error:`, err?.message || err);
    }
    return null;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/**
 * 调用 Claude 并解析 JSON 结果（最常用）
 * 自动剥离 markdown ```json ``` 包装
 * 解析失败返回 null
 */
export async function callClaudeJSON<T = any>(opts: ClaudeCallOptions): Promise<T | null> {
  const raw = await callClaude(opts);
  if (!raw) return null;

  let jsonStr = raw.text.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  // 兜底：抓 { ... } 块
  if (!jsonStr.startsWith('{') && !jsonStr.startsWith('[')) {
    const match = jsonStr.match(/\{[\s\S]*\}/);
    if (match) jsonStr = match[0];
  }

  try {
    return JSON.parse(jsonStr) as T;
  } catch (err: any) {
    console.error(`[claude:${opts.scene}] JSON parse failed:`, err?.message);
    return null;
  }
}
