import Anthropic from '@anthropic-ai/sdk';
import type {
  GenerateObjectRequest, GenerateTextRequest, ProviderAdapter, ProviderResponse, VisionRequest,
} from '../contracts';
import { AIRuntimeError, classifyProviderError } from '../errors';

export class AnthropicAdapter implements ProviderAdapter {
  readonly name = 'anthropic' as const;

  available(model: string) {
    if (!process.env.ANTHROPIC_API_KEY) return { available: false, reason: 'ANTHROPIC_API_KEY not configured' };
    if (!model) return { available: false, reason: 'Anthropic model not configured' };
    return { available: true };
  }

  private async call(request: GenerateTextRequest, model: string) {
    const started = Date.now();
    const timeoutMs = request.timeoutMs ?? 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
      const response = await client.messages.create({
        model, max_tokens: request.maxOutputTokens ?? 4096, system: request.system,
        messages: [{ role: 'user', content: request.prompt }],
      }, { timeout: timeoutMs, maxRetries: 0, signal: controller.signal });
      const text = response.content.filter(item => item.type === 'text').map(item => item.text).join('');
      if (!text.trim()) throw new AIRuntimeError({ code: 'EMPTY_RESPONSE', message: 'Anthropic returned no text', provider: 'anthropic' });
      return { response, text, latencyMs: Date.now() - started };
    } catch (error) { throw classifyProviderError(error, 'anthropic'); }
    finally { clearTimeout(timer); }
  }

  async generateText(request: GenerateTextRequest, model: string): Promise<ProviderResponse<string>> {
    const { response, text, latencyMs } = await this.call(request, model);
    return { data: text, provider: 'anthropic', model: response.model, latencyMs, requestId: response.id, usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens } };
  }

  async generateObject<T>(request: GenerateObjectRequest<T>, model: string): Promise<ProviderResponse<T>> {
    if (request.image || request.file) {
      throw new AIRuntimeError({ code: 'PROVIDER_UNAVAILABLE', message: 'Anthropic V1 compatibility adapter does not accept files/vision', provider: 'anthropic' });
    }
    const result = await this.call({ ...request, capability: request.capability === 'finance-readonly' ? 'finance-readonly' : 'text' }, model);
    let decoded: unknown;
    try { decoded = JSON.parse(result.text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')); }
    catch (cause) { throw new AIRuntimeError({ code: 'INVALID_JSON', message: 'Anthropic returned invalid JSON', provider: 'anthropic', cause }); }
    let parsed: T;
    try { parsed = request.schema.parse(decoded); }
    catch (cause) { throw new AIRuntimeError({ code: 'SCHEMA_MISMATCH', message: 'Anthropic output failed schema validation', provider: 'anthropic', cause }); }
    return { data: parsed, provider: 'anthropic', model: result.response.model, latencyMs: result.latencyMs, requestId: result.response.id, usage: { inputTokens: result.response.usage.input_tokens, outputTokens: result.response.usage.output_tokens } };
  }

  async vision<T = string>(request: VisionRequest<T>, model: string): Promise<ProviderResponse<T>> {
    void request;
    void model;
    throw new AIRuntimeError({ code: 'PROVIDER_UNAVAILABLE', message: 'Anthropic vision is not implemented in Runtime V1', provider: 'anthropic' });
  }
}
