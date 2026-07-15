import type { ProviderName } from './contracts';

export type AIErrorCode =
  | 'PROVIDER_UNAVAILABLE'
  | 'AUTHENTICATION'
  | 'RATE_LIMIT'
  | 'TIMEOUT'
  | 'TRANSIENT_PROVIDER'
  | 'PROVIDER_ERROR'
  | 'REFUSAL'
  | 'EMPTY_RESPONSE'
  | 'INVALID_JSON'
  | 'SCHEMA_MISMATCH'
  | 'MODEL_NOT_CONFIGURED'
  | 'ALL_PROVIDERS_FAILED';

export class AIRuntimeError extends Error {
  readonly code: AIErrorCode;
  readonly provider?: ProviderName;
  readonly retryable: boolean;
  readonly status?: number;
  readonly cause?: unknown;

  constructor(args: {
    code: AIErrorCode;
    message: string;
    provider?: ProviderName;
    retryable?: boolean;
    status?: number;
    cause?: unknown;
  }) {
    super(args.message);
    this.name = 'AIRuntimeError';
    this.code = args.code;
    this.provider = args.provider;
    this.retryable = args.retryable ?? false;
    this.status = args.status;
    this.cause = args.cause;
  }
}

type ErrorLike = { status?: number; statusCode?: number; code?: string; name?: string; message?: string };

export function classifyProviderError(error: unknown, provider: ProviderName): AIRuntimeError {
  if (error instanceof AIRuntimeError) return error;
  const value = (error ?? {}) as ErrorLike;
  const status = value.status ?? value.statusCode;
  const message = String(value.message ?? 'Provider request failed');
  if (status === 401 || status === 403) {
    return new AIRuntimeError({ code: 'AUTHENTICATION', message: `${provider} authentication failed`, provider, status, cause: error });
  }
  if (status === 429) {
    return new AIRuntimeError({ code: 'RATE_LIMIT', message: `${provider} rate limited`, provider, status, retryable: true, cause: error });
  }
  if (status === 408) {
    return new AIRuntimeError({ code: 'TIMEOUT', message: `${provider} request timed out`, provider, status, retryable: true, cause: error });
  }
  if (value.name === 'AbortError' || /abort|timed?\s*out|timeout/i.test(message)) {
    return new AIRuntimeError({ code: 'TIMEOUT', message: `${provider} request timed out`, provider, status, retryable: true, cause: error });
  }
  if (status === 409 || (status !== undefined && status >= 500)) {
    return new AIRuntimeError({ code: 'TRANSIENT_PROVIDER', message: `${provider} temporary failure`, provider, status, retryable: true, cause: error });
  }
  return new AIRuntimeError({ code: 'PROVIDER_ERROR', message: `${provider} request failed`, provider, status, cause: error });
}
