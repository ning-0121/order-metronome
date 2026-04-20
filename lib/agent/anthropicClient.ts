/**
 * Anthropic SDK 共享封装 — 超时保护 + Prompt Caching + Batch API
 *
 * ══ 2026-04-07 P1 修复 ══
 * 强制 30s 超时，失败返回 null（不抛异常）
 *
 * ══ 2026-04-19 成本优化 ══
 * 新增：
 *  1. Prompt Caching（ephemeral cache）
 *     - 对 system prompt 启用 cache_control，重复调用只收 10% 费用
 *     - Claude Sonnet 要求 ≥1024 tokens 才缓存，短 system prompt 自动跳过
 *     - 生命周期：5 分钟（同一 Vercel warm 实例内多次调用命中率高）
 *
 *  2. Batch API（非实时任务专用）
 *     - 提交一批请求 → 最多 24h 内返回，计费直接对半砍
 *     - 适合：agent-scan AI 增强、agent-learn、daily-briefing
 *     - 不适合：小绮对话（需实时）、PO 解析（用户等待中）
 *
 * 用法：
 *   // 普通调用（实时 + cache）
 *   const result = await callClaude({ scene: 'po-verify', system: '...', prompt: '...', cacheSystem: true });
 *
 *   // Batch 调用（非实时）
 *   const batchId = await submitBatch([{ customId: 'order-xxx', system: '...', prompt: '...' }]);
 *   // 之后用 pollBatchResults(batchId) 取结果
 */

import Anthropic from '@anthropic-ai/sdk';

// ── 类型定义 ───────────────────────────────────────────────────

export interface ClaudeCallOptions {
  /** 调用场景标识，用于日志 */
  scene: string;
  /** Prompt 文本 — 普通文本 prompt 用 user message */
  prompt?: string;
  /** 完整 messages 数组 — 用于多轮/多模态 */
  messages?: Anthropic.MessageParam[];
  /** System prompt（可选） */
  system?: string;
  /** 模型 ID，默认 claude-sonnet-4-20250514 */
  model?: string;
  /** max_tokens，默认 1024 */
  maxTokens?: number;
  /** 超时毫秒，默认 30s */
  timeoutMs?: number;
  /**
   * 是否对 system prompt 启用 ephemeral cache（默认 true）
   * 设为 false 可跳过 cache（如 system prompt 太短 < 300 tokens 时无意义）
   */
  cacheSystem?: boolean;
}

export interface ClaudeRawResult {
  text: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

// Batch 单条请求
export interface BatchRequest {
  customId: string;
  system?: string;
  prompt?: string;
  messages?: Anthropic.MessageParam[];
  model?: string;
  maxTokens?: number;
  cacheSystem?: boolean;
}

// Batch 单条结果
export interface BatchResult {
  customId: string;
  text: string | null;
  error?: string;
}

// ── 共享 client（模块级单例，避免重复实例化） ──────────────────

let _client: Anthropic | null = null;
function getClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (!_client) _client = new Anthropic({ apiKey });
  return _client;
}

// ── 工具函数 ──────────────────────────────────────────────────

/**
 * 构建带 cache_control 的 system 参数
 * Anthropic 要求 system 为 TextBlockParam[] 时才能加 cache_control
 * 如果 system 文本较短（估算 < 800 chars ≈ < 300 tokens），跳过 cache 节省 API overhead
 */
function buildSystemParam(
  system: string,
  useCache: boolean,
): Anthropic.TextBlockParam[] | string {
  // 短于 800 字符约等于 300 tokens，低于 Sonnet 1024 token 缓存门槛，直接返回字符串
  if (!useCache || system.length < 800) return system;
  return [
    {
      type: 'text',
      text: system,
      cache_control: { type: 'ephemeral' },
    } as Anthropic.TextBlockParam,
  ];
}

// ── 主调用函数 ────────────────────────────────────────────────

/**
 * 调用 Claude 并返回纯文本结果
 * 失败 / 超时 / 无 API key 都返回 null（不抛异常）
 */
export async function callClaude(opts: ClaudeCallOptions): Promise<ClaudeRawResult | null> {
  const client = getClient();
  if (!client) {
    console.warn(`[claude:${opts.scene}] ANTHROPIC_API_KEY not set, skip`);
    return null;
  }

  const timeoutMs = opts.timeoutMs ?? 30_000;
  const model = opts.model ?? 'claude-sonnet-4-20250514';
  const maxTokens = opts.maxTokens ?? 1024;
  const cacheSystem = opts.cacheSystem !== false; // 默认 true

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const messages: Anthropic.MessageParam[] = opts.messages
      ? opts.messages
      : opts.prompt
        ? [{ role: 'user', content: opts.prompt }]
        : [];

    if (messages.length === 0) {
      console.warn(`[claude:${opts.scene}] no prompt/messages provided`);
      return null;
    }

    const systemParam = opts.system
      ? buildSystemParam(opts.system, cacheSystem)
      : undefined;

    const response = await client.messages.create(
      {
        model,
        max_tokens: maxTokens,
        ...(systemParam ? { system: systemParam as any } : {}),
        messages,
      },
      { signal: controller.signal },
    );

    const text = response.content
      .filter(block => block.type === 'text')
      .map(block => (block as Anthropic.TextBlock).text)
      .join('');

    // 打印 cache 命中情况（方便监控成本）
    const usage = response.usage as any;
    if (usage?.cache_read_input_tokens > 0) {
      console.log(`[claude:${opts.scene}] 💰 cache HIT ${usage.cache_read_input_tokens} tokens saved`);
    } else if (usage?.cache_creation_input_tokens > 0) {
      console.log(`[claude:${opts.scene}] 📦 cache WRITE ${usage.cache_creation_input_tokens} tokens cached`);
    }

    return {
      text,
      usage: {
        input_tokens: usage?.input_tokens,
        output_tokens: usage?.output_tokens,
        cache_creation_input_tokens: usage?.cache_creation_input_tokens,
        cache_read_input_tokens: usage?.cache_read_input_tokens,
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
    const match = jsonStr.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (match) jsonStr = match[0];
  }

  try {
    return JSON.parse(jsonStr) as T;
  } catch (err: any) {
    console.error(`[claude:${opts.scene}] JSON parse failed:`, err?.message);
    return null;
  }
}

// ── Batch API ─────────────────────────────────────────────────

/**
 * 提交一批 Claude 请求（Batch API）
 * 计费是实时调用的 50%，适合 agent-scan AI 增强、daily-briefing 等非实时任务
 *
 * @returns batchId（用于后续 pollBatchResults）, 或 null（失败/不支持）
 */
export async function submitBatch(requests: BatchRequest[]): Promise<string | null> {
  const client = getClient();
  if (!client) {
    console.warn('[claude:batch] ANTHROPIC_API_KEY not set');
    return null;
  }
  if (requests.length === 0) return null;

  try {
    const batchRequests: Anthropic.Messages.MessageCreateParamsNonStreaming[] = requests.map(req => {
      const model = req.model ?? 'claude-sonnet-4-20250514';
      const maxTokens = req.maxTokens ?? 1024;
      const cacheSystem = req.cacheSystem !== false;

      const messages: Anthropic.MessageParam[] = req.messages
        ? req.messages
        : req.prompt
          ? [{ role: 'user', content: req.prompt }]
          : [];

      const systemParam = req.system
        ? buildSystemParam(req.system, cacheSystem)
        : undefined;

      return {
        model,
        max_tokens: maxTokens,
        ...(systemParam ? { system: systemParam as any } : {}),
        messages,
      };
    });

    const batch = await (client.messages.batches as any).create({
      requests: requests.map((req, i) => ({
        custom_id: req.customId,
        params: batchRequests[i],
      })),
    });

    console.log(`[claude:batch] submitted ${requests.length} requests, batch_id=${batch.id}`);
    return batch.id as string;
  } catch (err: any) {
    console.error('[claude:batch] submit failed:', err?.message || err);
    return null;
  }
}

/**
 * 轮询 Batch 结果（同步等待，适合单次 cron 内有限等待）
 *
 * @param batchId Batch ID
 * @param maxWaitMs 最多等待毫秒数（默认 0 = 不等待，直接返回当前状态）
 * @returns 已完成的结果数组，未完成返回 null
 */
export async function pollBatchResults(
  batchId: string,
  maxWaitMs = 0,
): Promise<BatchResult[] | null> {
  const client = getClient();
  if (!client) return null;

  const deadline = Date.now() + maxWaitMs;

  while (true) {
    try {
      const batch = await (client.messages.batches as any).retrieve(batchId);
      if (batch.processing_status === 'ended') {
        // 收集结果
        const results: BatchResult[] = [];
        for await (const result of (client.messages.batches as any).results(batchId)) {
          if (result.result.type === 'succeeded') {
            const text = result.result.message.content
              .filter((b: any) => b.type === 'text')
              .map((b: any) => b.text)
              .join('');
            results.push({ customId: result.custom_id, text });
          } else {
            results.push({
              customId: result.custom_id,
              text: null,
              error: result.result.type,
            });
          }
        }
        console.log(`[claude:batch] ${batchId} done, ${results.length} results`);
        return results;
      }

      if (Date.now() >= deadline) {
        console.log(`[claude:batch] ${batchId} still processing (${batch.request_counts?.processing || '?'} pending)`);
        return null;
      }

      // 等 10s 再轮询
      await new Promise(r => setTimeout(r, 10_000));
    } catch (err: any) {
      console.error('[claude:batch] poll failed:', err?.message);
      return null;
    }
  }
}

/**
 * 取消进行中的 Batch（用于错误恢复）
 */
export async function cancelBatch(batchId: string): Promise<void> {
  const client = getClient();
  if (!client) return;
  try {
    await (client.messages.batches as any).cancel(batchId);
    console.log(`[claude:batch] cancelled ${batchId}`);
  } catch {}
}
