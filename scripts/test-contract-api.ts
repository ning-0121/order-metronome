// ============================================================
// Contract API v1 — 自签名单元测试 + 可选 e2e（无测试框架，用 node:assert）
// 运行: npx tsx scripts/test-contract-api.ts
// 可选 e2e（需 dev server 且其 env 用下列同款 test key）:
//   CONTRACT_E2E_BASE_URL=http://localhost:3000 npx tsx scripts/test-contract-api.ts
// 只 import 无 `@/` 依赖的纯函数（auth/scopes），不触达 Next/Supabase。
// ============================================================

import assert from 'node:assert/strict';
import { buildSignString, hmacHex, verifyContractRequest } from '../app/api/contract/v1/_lib/auth';
import { canSeeFinancials, scopeSatisfies, SCOPES } from '../app/api/contract/v1/_lib/scopes';

// 固定 test key/secret（hermetic：覆盖任何外部 env，保证单元测确定性）
const FK = 'test-finance-key';
const FS = 'test-finance-secret';
const AK = 'test-araos-key';
const AS = 'test-araos-secret';
process.env.CONTRACT_KEY_FINANCE = FK;
process.env.CONTRACT_SECRET_FINANCE = FS;
process.env.CONTRACT_KEY_ARAOS = AK;
process.env.CONTRACT_SECRET_ARAOS = AS;

let passed = 0;
function pass(name: string) {
  passed++;
  console.log(`  ✓ ${name}`);
}

function sign(method: string, path: string, ts: string, key: string, secret: string): string {
  return hmacHex(secret, buildSignString(method, path, ts, key));
}

async function main() {
  console.log('Contract API — unit tests');

  // scopes
  assert.equal(canSeeFinancials(SCOPES.FINANCE_READ), true);
  pass('finance scope sees financials');
  assert.equal(canSeeFinancials(SCOPES.COMMERCIAL_READ), false);
  pass('commercial scope cannot see financials');
  assert.equal(scopeSatisfies(SCOPES.FINANCE_READ, SCOPES.FINANCE_READ), true);
  pass('scope satisfies self');
  assert.equal(scopeSatisfies(SCOPES.COMMERCIAL_READ, SCOPES.FINANCE_READ), false);
  pass('commercial cannot satisfy finance-required');

  // canonical sign string
  assert.equal(
    buildSignString('get', '/api/contract/v1/orders/abc', '123', 'k'),
    'GET\n/api/contract/v1/orders/abc\n123\nk',
  );
  pass('signString canonical form');

  const now = 1_000_000_000_000;
  const path = '/api/contract/v1/orders/abc';
  const ts = String(now);

  assert.deepEqual(
    verifyContractRequest({ method: 'GET', path, apiKey: null, timestamp: ts, signature: 'x', now }),
    { ok: false, code: 'missing_api_key', status: 401 },
  );
  pass('missing_api_key');

  assert.deepEqual(
    verifyContractRequest({ method: 'GET', path, apiKey: 'nope', timestamp: ts, signature: 'x', now }),
    { ok: false, code: 'invalid_api_key', status: 401 },
  );
  pass('invalid_api_key');

  {
    const oldTs = String(now - 400_000); // > ±300s
    const sig = sign('GET', path, oldTs, FK, FS);
    assert.deepEqual(
      verifyContractRequest({ method: 'GET', path, apiKey: FK, timestamp: oldTs, signature: sig, now }),
      { ok: false, code: 'timestamp_expired', status: 401 },
    );
    pass('timestamp_expired');
  }

  assert.deepEqual(
    verifyContractRequest({ method: 'GET', path, apiKey: FK, timestamp: ts, signature: 'deadbeef', now }),
    { ok: false, code: 'invalid_signature', status: 401 },
  );
  pass('invalid_signature');

  {
    const sig = sign('GET', path, ts, FK, FS);
    assert.deepEqual(
      verifyContractRequest({ method: 'GET', path, apiKey: FK, timestamp: ts, signature: sig, now }),
      { ok: true, keyId: 'finance', scope: 'finance.read' },
    );
    pass('finance valid -> finance.read');
  }

  {
    const sig = sign('GET', path, ts, AK, AS);
    assert.deepEqual(
      verifyContractRequest({ method: 'GET', path, apiKey: AK, timestamp: ts, signature: sig, now }),
      { ok: true, keyId: 'araos', scope: 'commercial.read' },
    );
    pass('araos valid -> commercial.read');
  }

  {
    const sig = sign('GET', path, ts, AK, FS); // wrong secret for araos key
    const r = verifyContractRequest({ method: 'GET', path, apiKey: AK, timestamp: ts, signature: sig, now });
    assert.equal(r.ok, false);
    pass('araos key with wrong secret -> rejected');
  }

  console.log(`\nunit: ${passed} passed`);

  // ---- optional e2e（dev server 必须以上面同款 test key 运行）----
  const BASE = process.env.CONTRACT_E2E_BASE_URL;
  if (BASE) {
    console.log(`\nE2E against ${BASE}`);
    const ZERO = '00000000-0000-0000-0000-000000000000';
    async function call(p: string, key: string, secret: string) {
      const t = String(Date.now());
      const sig = sign('GET', p, t, key, secret);
      const res = await fetch(BASE + p, {
        headers: { 'x-api-key': key, 'x-timestamp': t, 'x-signature': sig },
      });
      return { status: res.status };
    }

    const noKey = await fetch(BASE + `/api/contract/v1/customers/${ZERO}`);
    assert.equal(noKey.status, 401);
    pass('e2e no-key -> 401');

    const fin = await call(`/api/contract/v1/customers/${ZERO}`, FK, FS);
    assert.equal(fin.status, 404);
    pass('e2e finance signed -> 404 for missing id (auth passed)');

    const araosOnFinance = await call(`/api/contract/v1/finance/order-snapshot/${ZERO}`, AK, AS);
    assert.equal(araosOnFinance.status, 403);
    pass('e2e araos -> finance endpoint -> 403');
  } else {
    console.log('\n(e2e skipped — set CONTRACT_E2E_BASE_URL to run live checks)');
  }

  console.log('\nALL TESTS PASSED');
}

main().catch((e) => {
  console.error('\nTEST FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
