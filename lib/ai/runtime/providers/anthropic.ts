import Anthropic from '@anthropic-ai/sdk';
import type {
  FileInput, GenerateObjectRequest, GenerateTextRequest, ImageInput,
  ProviderAdapter, ProviderResponse, VisionRequest,
} from '../contracts';
import { AIRuntimeError, classifyProviderError } from '../errors';
import { assertDailyBudget, recordSpend } from '@/lib/ai/spend-budget';

type Block = Anthropic.ContentBlockParam;

/** 把图片/PDF 拼成 Claude 的多模态内容块(图片=image,PDF=document)。 */
function mediaBlocks(image?: ImageInput, file?: FileInput): Block[] {
  const blocks: Block[] = [];
  if (image) {
    blocks.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } });
  }
  if (file) {
    blocks.push({ type: 'document', source: { type: 'base64', media_type: file.mediaType, data: file.base64 } } as Block);
  }
  return blocks;
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly name = 'anthropic' as const;

  available(model: string) {
    if (!process.env.ANTHROPIC_API_KEY) return { available: false, reason: 'ANTHROPIC_API_KEY not configured' };
    if (!model) return { available: false, reason: 'Anthropic model not configured' };
    return { available: true };
  }

  private async call(args: {
    model: string; system?: string; timeoutMs?: number; maxTokens?: number;
    content: Block[]; tool?: { name: string; schema: Record<string, unknown> };
  }) {
    // 日花费硬性封顶:超上限则抛 AiBudgetExceeded(暂停调用,次日自动恢复)
    await assertDailyBudget();
    const started = Date.now();
    const timeoutMs = args.timeoutMs ?? 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
      const response = await client.messages.create({
        model: args.model,
        max_tokens: args.maxTokens ?? 4096,
        ...(args.system ? { system: args.system } : {}),
        messages: [{ role: 'user', content: args.content }],
        ...(args.tool ? {
          // 用 tool-use 强制结构化输出:定义一个 schema 工具并强制调用,取 tool_use.input 即结构化对象。
          tools: [{ name: args.tool.name, description: `Return the extracted result as ${args.tool.name}.`, input_schema: args.tool.schema as any }],
          tool_choice: { type: 'tool', name: args.tool.name },
        } : {}),
      }, { timeout: timeoutMs, maxRetries: 0, signal: controller.signal });
      const u = response.usage as any;
      await recordSpend(response.model || args.model, u?.input_tokens ?? 0, u?.output_tokens ?? 0, args.tool?.name || 'runtime');
      return { response, latencyMs: Date.now() - started };
    } catch (error) { throw classifyProviderError(error, 'anthropic'); }
    finally { clearTimeout(timer); }
  }

  private meta<T>(response: Anthropic.Message, data: T, latencyMs: number): ProviderResponse<T> {
    const usage = response.usage as any;
    return {
      data, provider: 'anthropic', model: response.model, latencyMs, requestId: response.id,
      usage: {
        inputTokens: usage?.input_tokens,
        outputTokens: usage?.output_tokens,
        cachedInputTokens: usage?.cache_read_input_tokens,
      },
    };
  }

  private text(response: Anthropic.Message): string {
    return response.content.filter(b => b.type === 'text').map(b => (b as Anthropic.TextBlock).text).join('');
  }

  async generateText(request: GenerateTextRequest, model: string): Promise<ProviderResponse<string>> {
    const { response, latencyMs } = await this.call({
      model, system: request.system, timeoutMs: request.timeoutMs, maxTokens: request.maxOutputTokens,
      content: [{ type: 'text', text: request.prompt }],
    });
    const text = this.text(response);
    if (!text.trim()) throw new AIRuntimeError({ code: 'EMPTY_RESPONSE', message: 'Anthropic returned no text', provider: 'anthropic' });
    return this.meta(response, text, latencyMs);
  }

  async generateObject<T>(request: GenerateObjectRequest<T>, model: string): Promise<ProviderResponse<T>> {
    const content: Block[] = [{ type: 'text', text: request.prompt }, ...mediaBlocks(request.image, request.file)];
    const { response, latencyMs } = await this.call({
      model, system: request.system, timeoutMs: request.timeoutMs ?? 45_000, maxTokens: request.maxOutputTokens ?? 4096,
      content, tool: { name: request.schema.name, schema: request.schema.jsonSchema as Record<string, unknown> },
    });
    const toolUse = response.content.find(b => b.type === 'tool_use') as Anthropic.ToolUseBlock | undefined;
    if (!toolUse) {
      throw new AIRuntimeError({ code: 'EMPTY_RESPONSE', message: 'Anthropic returned no structured tool output', provider: 'anthropic' });
    }
    let parsed: T;
    try { parsed = request.schema.parse(toolUse.input); }
    catch (cause) { throw new AIRuntimeError({ code: 'SCHEMA_MISMATCH', message: 'Anthropic output failed schema validation', provider: 'anthropic', cause }); }
    return this.meta(response, parsed, latencyMs);
  }

  async vision<T = string>(request: VisionRequest<T>, model: string): Promise<ProviderResponse<T>> {
    if (request.schema) {
      return this.generateObject(
        { ...request, capability: 'structured-extraction', schema: request.schema, image: request.image },
        model,
      );
    }
    const { response, latencyMs } = await this.call({
      model, system: request.system, timeoutMs: request.timeoutMs ?? 45_000, maxTokens: request.maxOutputTokens ?? 4096,
      content: [{ type: 'text', text: request.prompt }, ...mediaBlocks(request.image, undefined)],
    });
    const text = this.text(response);
    if (!text.trim()) throw new AIRuntimeError({ code: 'EMPTY_RESPONSE', message: 'Anthropic returned no vision output', provider: 'anthropic' });
    return this.meta(response, text as T, latencyMs);
  }
}
