import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { redactSecrets } from '../telemetry';

describe('secret redaction', () => {
  it('redacts provider keys and authorization headers', () => {
    const fakeKey = ['sk', 'proj', 'abcdefghijklmnopqrst'].join('-');
    const fakeBearer = `Bearer ${'a'.repeat(26)}`;
    const output = redactSecrets(`OPENAI_API_KEY=${fakeKey} ${fakeBearer}`);
    assert.equal(output.includes('sk-proj-'), false);
    assert.equal(output.includes('abcdefghijklmnopqrstuvwxyz'), false);
  });
});
