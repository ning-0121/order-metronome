import { QimoAIGateway } from './gateway';
import { AnthropicAdapter } from './providers/anthropic';

export * from './contracts';
export * from './compat';
export * from './errors';
export * from './gateway';
export * from './registry';
export * from './router';
export * from './telemetry';
export * from './tool-safety';

// 2026-07-20 用户拍板:纯 Claude Sonnet,运行时只注册 Anthropic(已移除 OpenAI adapter)。
// Anthropic adapter 现已支持图片/PDF 多模态 + tool-use 结构化输出,PO 解析/核对可直接跑 Claude。
export const qimoAI = new QimoAIGateway([
  new AnthropicAdapter(),
]);

export const streamText = { status: 'reserved-v1' } as const;
export const toolLoop = { status: 'reserved-v1' } as const;
export const batch = { status: 'reserved-v1' } as const;
