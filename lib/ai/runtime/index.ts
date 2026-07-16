import { QimoAIGateway } from './gateway';
import { AnthropicAdapter } from './providers/anthropic';
import { OpenAIAdapter } from './providers/openai';

export * from './contracts';
export * from './compat';
export * from './errors';
export * from './gateway';
export * from './registry';
export * from './router';
export * from './telemetry';
export * from './tool-safety';

export const qimoAI = new QimoAIGateway([
  new OpenAIAdapter(),
  new AnthropicAdapter(),
]);

export const streamText = { status: 'reserved-v1' } as const;
export const toolLoop = { status: 'reserved-v1' } as const;
export const batch = { status: 'reserved-v1' } as const;
