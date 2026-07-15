import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createSmokePostHandler, type SmokeExecutionResult } from './smoke-handler';

const success: SmokeExecutionResult = {
  provider: 'openai', model: 'mock-model', latencyMs: 12,
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, schemaValid: true, fieldMatchCount: 5,
};

function harness() {
  let consumed = false; let calls = 0;
  const handler = createSmokePostHandler({
    environment: () => 'preview', token: () => 'test-token', nonce: () => 'test-nonce',
    state: { isConsumed: () => consumed, consume: () => { consumed = true; } },
    execute: async () => { calls += 1; return success; },
  });
  const request = (headers: Record<string, string> = {}) => new Request('https://preview.invalid/api/internal/ai-runtime-smoke', { method: 'POST', headers });
  return { handler, request, calls: () => calls };
}

describe('protected Preview AI smoke endpoint', () => {
  it('rejects missing or wrong dedicated token and nonce', async () => {
    assert.equal((await harness().handler(harness().request())).status, 401);
    const wrongToken = harness();
    assert.equal((await wrongToken.handler(wrongToken.request({ 'x-qimo-smoke-token': 'wrong', 'x-qimo-smoke-nonce': 'test-nonce' }))).status, 401);
    const wrongNonce = harness();
    assert.equal((await wrongNonce.handler(wrongNonce.request({ 'x-qimo-smoke-token': 'test-token', 'x-qimo-smoke-nonce': 'wrong' }))).status, 401);
  });

  it('ignores Authorization and executes once with dedicated headers', async () => {
    const test = harness();
    const headers = { authorization: 'Vercel protection value', 'x-qimo-smoke-token': 'test-token', 'x-qimo-smoke-nonce': 'test-nonce' };
    assert.equal((await test.handler(test.request(headers))).status, 200);
    assert.equal((await test.handler(test.request(headers))).status, 410);
    assert.equal(test.calls(), 1);
  });

  it('does not expose secrets, prompt, or output', async () => {
    const test = harness();
    const body = await (await test.handler(test.request({ 'x-qimo-smoke-token': 'test-token', 'x-qimo-smoke-nonce': 'test-nonce' }))).text();
    for (const value of ['TEST-001', 'Demo Customer', 'test-token', 'test-nonce', '"prompt"', '"data"']) assert.equal(body.includes(value), false);
  });

  it('pins direct adapter, retry zero, and fallback disabled', () => {
    const route = readFileSync(join(process.cwd(), 'app/api/internal/ai-runtime-smoke/route.ts'), 'utf8');
    const adapter = readFileSync(join(process.cwd(), 'lib/ai/runtime/providers/openai.ts'), 'utf8');
    assert.equal(route.includes('new OpenAIAdapter()'), true);
    assert.equal(route.includes("fallback: 'disabled'"), true);
    assert.equal(adapter.includes('maxRetries: 0'), true);
  });
});
