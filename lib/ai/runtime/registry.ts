import type { AICapability, LogicalModel, ProviderName } from './contracts';

const MODEL_ENV: Record<LogicalModel, string> = {
  'qimo.fast-text': 'QIMO_MODEL_FAST_TEXT',
  'qimo.reasoning': 'QIMO_MODEL_REASONING',
  'qimo.vision': 'QIMO_MODEL_VISION',
  'qimo.structured-extraction': 'QIMO_MODEL_STRUCTURED_EXTRACTION',
  'qimo.finance-readonly': 'QIMO_MODEL_REASONING',
};

export function modelEnvironmentVariable(logicalModel: LogicalModel): string {
  return MODEL_ENV[logicalModel];
}

const CAPABILITY_MODEL: Record<AICapability, LogicalModel> = {
  text: 'qimo.fast-text',
  reasoning: 'qimo.reasoning',
  vision: 'qimo.vision',
  'structured-extraction': 'qimo.structured-extraction',
  'finance-readonly': 'qimo.finance-readonly',
};

export function logicalModelFor(capability: AICapability, explicit?: LogicalModel): LogicalModel {
  return explicit ?? CAPABILITY_MODEL[capability];
}

/**
 * A model env may be a plain ID (assigned to the primary provider) or a list:
 * `openai=model-a;anthropic=model-b`. This keeps business code model-neutral.
 */
export function resolveModel(logicalModel: LogicalModel, provider: ProviderName, primary: ProviderName): string | undefined {
  const raw = process.env[MODEL_ENV[logicalModel]]?.trim();
  if (!raw) return undefined;
  if (!raw.includes('=')) return provider === primary ? raw : undefined;
  const entries = raw.split(';').map(part => part.trim()).filter(Boolean);
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    if (separator < 1) continue;
    if (entry.slice(0, separator).trim() === provider) return entry.slice(separator + 1).trim() || undefined;
  }
  return undefined;
}

export function primaryProvider(): ProviderName {
  return parseProvider(process.env.QIMO_AI_PRIMARY_PROVIDER) ?? 'openai';
}

export function fallbackProviders(): ProviderName[] {
  const raw = process.env.QIMO_AI_FALLBACK_PROVIDERS ?? 'anthropic';
  return raw.split(',').map(value => parseProvider(value)).filter((value): value is ProviderName => Boolean(value));
}

function parseProvider(value?: string): ProviderName | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'openai' || normalized === 'anthropic' || normalized === 'gemini' || normalized === 'openrouter') return normalized;
  return undefined;
}
