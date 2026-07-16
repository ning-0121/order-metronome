import type { ProviderAttempt, ProviderName, RuntimeMetadata } from './contracts';

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi,
  /(OPENAI_API_KEY|ANTHROPIC_API_KEY)\s*[=:]\s*[^\s,;]+/gi,
];

export function redactSecrets(value: unknown): string {
  let text: string;
  try { text = typeof value === 'string' ? value : JSON.stringify(value); }
  catch { text = String(value); }
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[REDACTED]');
  return text;
}

export interface AuditEvent {
  event: 'qimo.ai.completed' | 'qimo.ai.failed';
  scene: string;
  traceId: string;
  provider?: ProviderName;
  model?: string;
  latencyMs: number;
  fallbackUsed: boolean;
  requestedProvider?: ProviderName;
  fallbackReason?: string;
  attempts: ProviderAttempt[];
  errorCode?: string;
}

export type AuditSink = (event: AuditEvent) => void | Promise<void>;

export const consoleAuditSink: AuditSink = event => {
  console.info('[qimo-ai-audit]', redactSecrets(event));
};

export function metadataAuditEvent(scene: string, metadata: RuntimeMetadata): AuditEvent {
  return {
    event: 'qimo.ai.completed', scene, traceId: metadata.traceId,
    provider: metadata.provider, model: metadata.model, latencyMs: metadata.latencyMs,
    fallbackUsed: metadata.fallbackUsed, requestedProvider: metadata.requestedProvider,
    fallbackReason: metadata.fallbackReason, attempts: metadata.attempts,
  };
}
