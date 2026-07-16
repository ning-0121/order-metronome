import { randomUUID } from 'node:crypto';
import type {
  GenerateObjectRequest, GenerateTextRequest, ProviderAdapter, ProviderAttempt, ProviderName, RuntimeResult, VisionRequest,
} from './contracts';
import { AIRuntimeError, classifyProviderError } from './errors';
import { buildRoutePlan } from './router';
import { modelEnvironmentVariable } from './registry';
import { consoleAuditSink, metadataAuditEvent, type AuditSink } from './telemetry';

const RETRYABLE = new Set(['RATE_LIMIT', 'TIMEOUT', 'TRANSIENT_PROVIDER']);

export class QimoAIGateway {
  private readonly adapters: Map<ProviderName, ProviderAdapter>;
  private readonly auditSink: AuditSink;

  constructor(adapters: ProviderAdapter[], auditSink: AuditSink = consoleAuditSink) {
    this.adapters = new Map(adapters.map(adapter => [adapter.name, adapter]));
    this.auditSink = auditSink;
  }

  generateText(request: GenerateTextRequest): Promise<RuntimeResult<string>> {
    return this.execute(request, (adapter, model) => adapter.generateText(request, model));
  }

  generateObject<T>(request: GenerateObjectRequest<T>): Promise<RuntimeResult<T>> {
    return this.execute(request, (adapter, model) => adapter.generateObject(request, model));
  }

  vision<T = string>(request: VisionRequest<T>): Promise<RuntimeResult<T>> {
    return this.execute(request, (adapter, model) => adapter.vision(request, model));
  }

  private async execute<T>(
    request: GenerateTextRequest | GenerateObjectRequest<T> | VisionRequest<T>,
    invoke: (adapter: ProviderAdapter, model: string) => Promise<{ data: T; provider: ProviderName; model: string; latencyMs: number; requestId?: string; usage: RuntimeResult<T>['metadata']['usage'] }>,
  ): Promise<RuntimeResult<T>> {
    const traceId = request.traceId ?? randomUUID();
    const started = Date.now();
    const plan = buildRoutePlan({ ...request, adapters: this.adapters });
    const attempts: ProviderAttempt[] = [];
    let lastError: AIRuntimeError | undefined;

    for (let candidateIndex = 0; candidateIndex < plan.candidates.length; candidateIndex++) {
      const candidate = plan.candidates[candidateIndex];
      if (!candidate.model) {
        attempts.push({ provider: candidate.provider, status: 'unavailable', errorCode: 'MODEL_NOT_CONFIGURED', latencyMs: 0 });
        continue;
      }
      const availability = await candidate.adapter.available(candidate.model);
      if (!availability.available) {
        attempts.push({ provider: candidate.provider, model: candidate.model, status: 'unavailable', errorCode: 'PROVIDER_UNAVAILABLE', latencyMs: 0 });
        continue;
      }

      const maxAttempts = 2;
      for (let retry = 0; retry < maxAttempts; retry++) {
        const attemptStarted = Date.now();
        try {
          const response = await invoke(candidate.adapter, candidate.model);
          attempts.push({ provider: response.provider, model: response.model, status: 'success', latencyMs: response.latencyMs });
          const metadata = {
            provider: response.provider, model: response.model, logicalModel: plan.logicalModel,
            latencyMs: Date.now() - started, requestId: response.requestId, traceId, usage: response.usage,
            fallbackUsed: response.provider !== plan.primaryProvider, primaryProvider: plan.primaryProvider,
            requestedProvider: plan.primaryProvider,
            fallbackReason: response.provider === plan.primaryProvider ? undefined : fallbackReason(attempts, plan.primaryProvider),
            attempts,
          };
          await this.auditSink(metadataAuditEvent(request.scene, metadata));
          return { data: response.data, metadata };
        } catch (error) {
          lastError = classifyProviderError(error, candidate.provider);
          attempts.push({ provider: candidate.provider, model: candidate.model, status: lastError.code === 'AUTHENTICATION' ? 'unavailable' : 'failed', errorCode: lastError.code, latencyMs: Date.now() - attemptStarted });
          if (!RETRYABLE.has(lastError.code) || retry === maxAttempts - 1) break;
        }
      }
    }

    const missingModel = attempts.length > 0 && attempts.every(attempt => attempt.errorCode === 'MODEL_NOT_CONFIGURED');
    const failure = new AIRuntimeError({
      code: missingModel ? 'MODEL_NOT_CONFIGURED' : 'ALL_PROVIDERS_FAILED',
      message: missingModel
        ? `Missing required model configuration: ${modelEnvironmentVariable(plan.logicalModel)}`
        : 'All configured AI providers failed or were unavailable',
      retryable: Boolean(lastError?.retryable),
      cause: { lastError, traceId, attempts },
    });
    await this.auditSink({ event: 'qimo.ai.failed', scene: request.scene, traceId, latencyMs: Date.now() - started, fallbackUsed: attempts.some(a => a.provider !== plan.primaryProvider), attempts, errorCode: failure.code });
    throw failure;
  }
}

function fallbackReason(attempts: ProviderAttempt[], primary: ProviderName): string | undefined {
  const primaryFailures = attempts.filter(attempt => attempt.provider === primary && attempt.status !== 'success');
  if (primaryFailures.length === 0) return undefined;
  return primaryFailures.map(attempt => attempt.errorCode ?? attempt.status).join(',');
}
