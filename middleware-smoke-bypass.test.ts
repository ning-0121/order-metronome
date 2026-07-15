import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { shouldBypassForPreviewSmoke } from './middleware-smoke-bypass';

describe('temporary Preview smoke middleware bypass', () => {
  it('does not bypass the exact path in Production', () => {
    assert.equal(shouldBypassForPreviewSmoke({ environment: 'production', method: 'POST', pathname: '/api/internal/ai-runtime-smoke' }), false);
  });

  it('does not bypass Preview GET', () => {
    assert.equal(shouldBypassForPreviewSmoke({ environment: 'preview', method: 'GET', pathname: '/api/internal/ai-runtime-smoke' }), false);
  });

  it('does not bypass other Preview POST paths', () => {
    assert.equal(shouldBypassForPreviewSmoke({ environment: 'preview', method: 'POST', pathname: '/api/internal/anything-else' }), false);
  });

  it('bypasses only the exact Preview POST smoke path', () => {
    assert.equal(shouldBypassForPreviewSmoke({ environment: 'preview', method: 'POST', pathname: '/api/internal/ai-runtime-smoke' }), true);
  });

  it('does not use a broad internal API prefix rule', () => {
    for (const pathname of ['/api/internal', '/api/internal/', '/api/internal/ai-runtime-smoke/extra']) {
      assert.equal(shouldBypassForPreviewSmoke({ environment: 'preview', method: 'POST', pathname }), false);
    }
    const source = readFileSync(join(process.cwd(), 'middleware-smoke-bypass.ts'), 'utf8');
    assert.equal(source.includes('startsWith'), false);
  });
});
