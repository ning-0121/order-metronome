import OpenAI from 'openai';
import type { Response, ResponseInput } from 'openai/resources/responses/responses';
import type {
  GenerateObjectRequest, GenerateTextRequest, ProviderAdapter, ProviderResponse, VisionRequest,
} from '../contracts';
import { AIRuntimeError, classifyProviderError } from '../errors';

type OpenAIClient = Pick<OpenAI, 'responses'>;

async function withAbortTimeout<T>(timeoutMs: number, invoke: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await invoke(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export function buildOpenAIVisionInput(request: VisionRequest<unknown>): ResponseInput {
  return [{
    role: 'user',
    content: [
      { type: 'input_text', text: request.prompt },
      {
        type: 'input_image',
        image_url: `data:${request.image.mediaType};base64,${request.image.base64}`,
        detail: request.image.detail ?? 'auto',
      },
    ],
  }];
}

export function buildOpenAIObjectInput<T>(request: GenerateObjectRequest<T>): ResponseInput {
  const content: Array<Record<string, unknown>> = [{ type: 'input_text', text: request.prompt }];
  if (request.image) {
    content.push({
      type: 'input_image',
      image_url: `data:${request.image.mediaType};base64,${request.image.base64}`,
      detail: request.image.detail ?? 'auto',
    });
  }
  if (request.file) {
    content.push({
      type: 'input_file',
      filename: request.file.filename,
      file_data: `data:${request.file.mediaType};base64,${request.file.base64}`,
    });
  }
  return [{ role: 'user', content: content as never }];
}

function refusal(response: Response): string | undefined {
  for (const output of response.output) {
    if (output.type !== 'message') continue;
    for (const item of output.content) if (item.type === 'refusal') return item.refusal;
  }
  return undefined;
}

function responseMeta<T>(response: Response, data: T, latencyMs: number): ProviderResponse<T> {
  return {
    data,
    provider: 'openai',
    model: response.model,
    latencyMs,
    requestId: response._request_id ?? response.id,
    usage: {
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
      totalTokens: response.usage?.total_tokens,
      cachedInputTokens: response.usage?.input_tokens_details?.cached_tokens,
    },
  };
}

export class OpenAIAdapter implements ProviderAdapter {
  readonly name = 'openai' as const;
  private readonly clientFactory: () => OpenAIClient;

  constructor(clientFactory?: () => OpenAIClient) {
    this.clientFactory = clientFactory ?? (() => new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 }));
  }

  available(model: string) {
    if (!process.env.OPENAI_API_KEY) return { available: false, reason: 'OPENAI_API_KEY not configured' };
    if (!model) return { available: false, reason: 'OpenAI model not configured' };
    return { available: true };
  }

  async generateText(request: GenerateTextRequest, model: string): Promise<ProviderResponse<string>> {
    const started = Date.now();
    try {
      const timeoutMs = request.timeoutMs ?? 30_000;
      const response = await withAbortTimeout(timeoutMs, signal => this.clientFactory().responses.create({
        model,
        instructions: request.system,
        input: request.prompt,
        max_output_tokens: request.maxOutputTokens,
      }, { timeout: timeoutMs, maxRetries: 0, signal }));
      const denied = refusal(response);
      if (denied) throw new AIRuntimeError({ code: 'REFUSAL', message: 'OpenAI refused the request', provider: 'openai' });
      if (!response.output_text?.trim()) throw new AIRuntimeError({ code: 'EMPTY_RESPONSE', message: 'OpenAI returned no text', provider: 'openai' });
      return responseMeta(response, response.output_text, Date.now() - started);
    } catch (error) { throw classifyProviderError(error, 'openai'); }
  }

  async generateObject<T>(request: GenerateObjectRequest<T>, model: string): Promise<ProviderResponse<T>> {
    const started = Date.now();
    try {
      const timeoutMs = request.timeoutMs ?? 45_000;
      const response = await withAbortTimeout(timeoutMs, signal => this.clientFactory().responses.create({
        model,
        instructions: request.system,
        input: buildOpenAIObjectInput(request),
        max_output_tokens: request.maxOutputTokens,
        text: { format: { type: 'json_schema', name: request.schema.name, strict: true, schema: request.schema.jsonSchema } },
      }, { timeout: timeoutMs, maxRetries: 0, signal }));
      const denied = refusal(response);
      if (denied) throw new AIRuntimeError({ code: 'REFUSAL', message: 'OpenAI refused the request', provider: 'openai' });
      if (!response.output_text?.trim()) throw new AIRuntimeError({ code: 'EMPTY_RESPONSE', message: 'OpenAI returned no structured output', provider: 'openai' });
      let decoded: unknown;
      try { decoded = JSON.parse(response.output_text); }
      catch (cause) { throw new AIRuntimeError({ code: 'INVALID_JSON', message: 'OpenAI returned invalid JSON', provider: 'openai', cause }); }
      let parsed: T;
      try { parsed = request.schema.parse(decoded); }
      catch (cause) { throw new AIRuntimeError({ code: 'SCHEMA_MISMATCH', message: 'OpenAI output failed schema validation', provider: 'openai', cause }); }
      return responseMeta(response, parsed, Date.now() - started);
    } catch (error) { throw classifyProviderError(error, 'openai'); }
  }

  async vision<T = string>(request: VisionRequest<T>, model: string): Promise<ProviderResponse<T>> {
    if (request.schema) {
      return this.generateObject({ ...request, capability: 'structured-extraction', schema: request.schema, image: request.image }, model);
    }
    const started = Date.now();
    try {
      const timeoutMs = request.timeoutMs ?? 45_000;
      const response = await withAbortTimeout(timeoutMs, signal => this.clientFactory().responses.create({
        model, instructions: request.system, input: buildOpenAIVisionInput(request), max_output_tokens: request.maxOutputTokens,
      }, { timeout: timeoutMs, maxRetries: 0, signal }));
      const denied = refusal(response);
      if (denied) throw new AIRuntimeError({ code: 'REFUSAL', message: 'OpenAI refused the vision request', provider: 'openai' });
      if (!response.output_text?.trim()) throw new AIRuntimeError({ code: 'EMPTY_RESPONSE', message: 'OpenAI returned no vision output', provider: 'openai' });
      return responseMeta(response, response.output_text as T, Date.now() - started);
    } catch (error) { throw classifyProviderError(error, 'openai'); }
  }
}
