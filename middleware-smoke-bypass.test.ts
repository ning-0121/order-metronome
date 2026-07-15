import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { shouldBypassForPreviewSmoke } from './middleware-smoke-bypass';

describe('temporary Preview smoke middleware bypass', () => {
  it('bypasses only Preview POST on the exact path', () => {
    assert.equal(shouldBypassForPreviewSmoke({ environment: 'preview', method: 'POST', pathname: '/api/internal/ai-runtime-smoke' }), true);
    assert.equal(shouldBypassForPreviewSmoke({ environment: 'production', method: 'POST', pathname: '/api/internal/ai-runtime-smoke' }), false);
    assert.equal(shouldBypassForPreviewSmoke({ environment: 'preview', method: 'GET', pathname: '/api/internal/ai-runtime-smoke' }), false);
    assert.equal(shouldBypassForPreviewSmoke({ environment: 'preview', method: 'POST', pathname: '/api/internal/other' }), false);
  });

  it('contains no broad internal API prefix rule', () => {
    const source = readFileSync(join(process.cwd(), 'middleware-smoke-bypass.ts'), 'utf8');
    assert.equal(source.includes('startsWith'), false);
  });
});
