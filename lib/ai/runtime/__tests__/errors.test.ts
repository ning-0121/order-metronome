import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyProviderError } from '../errors';

describe('provider error taxonomy', () => {
  it('classifies auth, rate limit, timeout, transient and permanent errors', () => {
    assert.equal(classifyProviderError({ status: 401 }, 'openai').code, 'AUTHENTICATION');
    assert.equal(classifyProviderError({ status: 403 }, 'openai').code, 'AUTHENTICATION');
    assert.equal(classifyProviderError({ status: 429 }, 'openai').code, 'RATE_LIMIT');
    assert.equal(classifyProviderError({ status: 408 }, 'openai').code, 'TIMEOUT');
    assert.equal(classifyProviderError({ status: 500 }, 'openai').code, 'TRANSIENT_PROVIDER');
    assert.equal(classifyProviderError({ status: 400 }, 'openai').code, 'PROVIDER_ERROR');
  });
});
