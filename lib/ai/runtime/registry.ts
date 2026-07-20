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
 * 默认模型:2026-07-20 用户拍板全面切 Claude Sonnet(纯 Claude,移除 OpenAI)。
 * 未显式配 QIMO_MODEL_* 时,anthropic 一律用 claude-sonnet-5;仍支持用环境变量覆盖。
 */
const DEFAULT_MODEL: Partial<Record<ProviderName, string>> = {
  anthropic: 'claude-sonnet-5',
};

/**
 * A model env may be a plain ID (assigned to the primary provider) or a list:
 * `openai=model-a;anthropic=model-b`. This keeps business code model-neutral.
 */
export function resolveModel(logicalModel: LogicalModel, provider: ProviderName, primary: ProviderName): string | undefined {
  const raw = process.env[MODEL_ENV[logicalModel]]?.trim();
  if (!raw) return DEFAULT_MODEL[provider];
  if (raw.includes('=')) {
    // `provider=model;...` 列表:取本 provider 的显式配置;列表里没有本 provider(如只留了 openai=...)→ 回落默认。
    for (const entry of raw.split(';').map(part => part.trim()).filter(Boolean)) {
      const separator = entry.indexOf('=');
      if (separator < 1) continue;
      if (entry.slice(0, separator).trim() === provider) return entry.slice(separator + 1).trim() || DEFAULT_MODEL[provider];
    }
    return DEFAULT_MODEL[provider];
  }
  // 纯模型 ID:anthropic 只接受 claude* 值,历史遗留的 openai 模型 ID(如 gpt-4o)忽略并回落 Sonnet,
  // 避免生产环境旧 QIMO_MODEL_* 把 Claude 主用毒化成非法模型(2026-07-20 纯 Claude 切换的兼容兜底)。
  if (provider === 'anthropic') return /^claude/i.test(raw) ? raw : DEFAULT_MODEL.anthropic;
  return provider === primary ? raw : undefined;
}

export function primaryProvider(): ProviderName {
  // 2026-07-20 用户拍板:纯 Claude,主用 anthropic。openai adapter 已移除,
  // 生产环境即便还留着 QIMO_AI_PRIMARY_PROVIDER=openai 也强制回 anthropic,避免无 adapter 直接失败。
  return 'anthropic';
}

export function fallbackProviders(): ProviderName[] {
  // 纯 Claude:默认无兜底(移除 openai)。仍可用 QIMO_AI_FALLBACK_PROVIDERS 环境变量显式配置。
  const raw = process.env.QIMO_AI_FALLBACK_PROVIDERS ?? '';
  return raw.split(',').map(value => parseProvider(value)).filter((value): value is ProviderName => Boolean(value));
}

function parseProvider(value?: string): ProviderName | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'openai' || normalized === 'anthropic' || normalized === 'gemini' || normalized === 'openrouter') return normalized;
  return undefined;
}
