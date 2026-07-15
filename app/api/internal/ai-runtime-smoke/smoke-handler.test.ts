import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSmokePostHandler, methodNotAllowed, type SmokeExecutionResult } from './smoke-handler';

const success: SmokeExecutionResult = {
  provider: 'openai', model: 'mock-model', latencyMs: 12,
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  schemaValid: true, fieldMatchCount: '5/5',
};

function harness(environment = 'preview') {
  let consumed = false;
  let calls = 0;
  const handler = createSmokePostHandler({
    environment: () => environment,
    token: () => 'test-token',
    nonce: () => 'test-nonce',
    state: { isConsumed: () => consumed, consume: () => { consumed = true; } },
    execute: async () => { calls += 1; return success; },
  });
  const request = (headers: Record<string, string> = {}) => new Request('https://preview.invalid/api/internal/ai-runtime-smoke', { method: 'POST', headers });
  return { handler, request, calls: () => calls };
}

describe('Preview-only AI smoke endpoint', () => {
  it('returns 404 outside Preview', async () => {
    const test = harness('production');
    assert.equal((await test.handler(test.request())).status, 404);
  });

  it('rejects missing or incorrect authorization', async () => {
    const missing = harness();
    assert.equal((await missing.handler(missing.request())).status, 401);
    const wrong = harness();
    assert.equal((await wrong.handler(wrong.request({ authorization: 'Bearer wrong', 'x-qimo-smoke-nonce': 'test-nonce' }))).status, 401);
  });

  it('rejects missing or incorrect nonce', async () => {
    const missing = harness();
    assert.equal((await missing.handler(missing.request({ authorization: 'Bearer test-token' }))).status, 401);
    const wrong = harness();
    assert.equal((await wrong.handler(wrong.request({ authorization: 'Bearer test-token', 'x-qimo-smoke-nonce': 'wrong' }))).status, 401);
  });

  it('returns 405 for non-POST methods', () => assert.equal(methodNotAllowed().status, 405));

  it('executes once, then returns 410 without another Runtime call', async () => {
    const test = harness();
    const headers = { authorization: 'Bearer test-token', 'x-qimo-smoke-nonce': 'test-nonce' };
    assert.equal((await test.handler(test.request(headers))).status, 200);
    assert.equal((await test.handler(test.request(headers))).status, 410);
    assert.equal(test.calls(), 1);
  });

  it('does not expose prompt, output, key, token, or nonce', async () => {
    const test = harness();
    const response = await test.handler(test.request({ authorization: 'Bearer test-token', 'x-qimo-smoke-nonce': 'test-nonce' }));
    const body = await response.text();
    for (const forbidden of ['TEST-001', 'Demo Customer', 'test-token', 'test-nonce', 'OPENAI_API_KEY', '"prompt"', '"data"']) {
      assert.equal(body.includes(forbidden), false);
    }
  });
});
