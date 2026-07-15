import type { GenerateObjectRequest, RuntimeMetadata, SchemaValidator } from './contracts';
import { AIRuntimeError } from './errors';
import { QimoAIGateway } from './gateway';

export interface LegacyGatewayCompatOptions<T> {
  task: string;
  input: unknown;
  system?: string;
  schema: SchemaValidator<T>;
  timeoutMs?: number;
  maxTokens?: number;
}

export interface LegacyGatewayCompatResult<T> {
  ok: boolean;
  data: T | null;
  reason?: string;
  durationMs: number;
  metadata?: RuntimeMetadata;
}

/** Transitional facade with the old `{ ok, data, reason }` result shape. */
export async function runLegacyJSON<T>(gateway: QimoAIGateway, options: LegacyGatewayCompatOptions<T>): Promise<LegacyGatewayCompatResult<T>> {
  const started = Date.now();
  const request: GenerateObjectRequest<T> = {
    scene: options.task,
    capability: 'structured-extraction',
    prompt: typeof options.input === 'string' ? options.input : JSON.stringify(options.input),
    system: options.system,
    schema: options.schema,
    timeoutMs: options.timeoutMs,
    maxOutputTokens: options.maxTokens,
  };
  try {
    const result = await gateway.generateObject(request);
    return { ok: true, data: result.data, durationMs: Date.now() - started, metadata: result.metadata };
  } catch (error) {
    return { ok: false, data: null, reason: error instanceof AIRuntimeError ? error.code : 'AIRuntimeError', durationMs: Date.now() - started };
  }
}
