import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { GenerateTextRequest, ProviderAdapter, ProviderName, ProviderResponse } from '../contracts';
import { AIRuntimeError } from '../errors';
import { QimoAIGateway } from '../gateway';

const request: GenerateTextRequest = { scene: 'test', capability: 'text', prompt: 'hello', fallback: 'allowed' };
const envSnapshot = { ...process.env };

function adapter(name: ProviderName, behavior: 'success' | 'unavailable' | 'auth' | 'timeout'): ProviderAdapter {
  const text = async (): Promise<ProviderResponse<string>> => {
    if (behavior === 'auth') throw Object.assign(new Error('unauthorized'), { status: 401 });
    if (behavior === 'timeout') throw new AIRuntimeError({ code: 'TIMEOUT', message: 'timeout', provider: name, retryable: true });
    return { data: `${name}-ok`, provider: name, model: `${name}-model`, latencyMs: 1, usage: { inputTokens: 1, outputTokens: 1 } };
  };
  return {
    name,
    available: () => ({ available: behavior !== 'unavailable' }),
    generateText: text,
    generateObject: async () => { throw new Error('unused'); },
    vision: async () => { throw new Error('unused'); },
  };
}

beforeEach(() => {
  process.env.QIMO_AI_PRIMARY_PROVIDER = 'openai';
  process.env.QIMO_AI_FALLBACK_PROVIDERS = 'anthropic';
  process.env.QIMO_MODEL_FAST_TEXT = 'openai=openai-model;anthropic=anthropic-model';
});
afterEach(() => { process.env = { ...envSnapshot }; });

describe('QimoAIGateway routing', () => {
  it('uses an available primary', async () => {
    const result = await new QimoAIGateway([adapter('openai', 'success'), adapter('anthropic', 'success')], () => {}).generateText(request);
    assert.equal(result.data, 'openai-ok');
    assert.equal(result.metadata.fallbackUsed, false);
  });

  it('skips an unavailable primary and records fallback', async () => {
    const result = await new QimoAIGateway([adapter('openai', 'unavailable'), adapter('anthropic', 'success')], () => {}).generateText(request);
    assert.equal(result.data, 'anthropic-ok');
    assert.equal(result.metadata.fallbackUsed, true);
    assert.equal(result.metadata.requestedProvider, 'openai');
    assert.equal(result.metadata.fallbackReason, 'PROVIDER_UNAVAILABLE');
    assert.equal(result.metadata.attempts[0].status, 'unavailable');
  });

  it('fails closed with the required variable name when the model is missing', async () => {
    delete process.env.QIMO_MODEL_FAST_TEXT;
    await assert.rejects(
      new QimoAIGateway([adapter('openai', 'success'), adapter('anthropic', 'success')], () => {}).generateText(request),
      (error: unknown) => error instanceof AIRuntimeError
        && error.code === 'MODEL_NOT_CONFIGURED'
        && error.message.includes('QIMO_MODEL_FAST_TEXT'),
    );
  });

  it('falls back after primary 401', async () => {
    const result = await new QimoAIGateway([adapter('openai', 'auth'), adapter('anthropic', 'success')], () => {}).generateText(request);
    assert.equal(result.metadata.provider, 'anthropic');
    assert.equal(result.metadata.attempts[0].errorCode, 'AUTHENTICATION');
  });

  it('retries a timeout then falls back', async () => {
    const result = await new QimoAIGateway([adapter('openai', 'timeout'), adapter('anthropic', 'success')], () => {}).generateText(request);
    assert.equal(result.metadata.provider, 'anthropic');
    assert.equal(result.metadata.attempts.filter(item => item.provider === 'openai').length, 2);
  });

  it('throws when all providers fail', async () => {
    await assert.rejects(
      new QimoAIGateway([adapter('openai', 'auth'), adapter('anthropic', 'unavailable')], () => {}).generateText(request),
      (error: unknown) => error instanceof AIRuntimeError && error.code === 'ALL_PROVIDERS_FAILED',
    );
  });
});
