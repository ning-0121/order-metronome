/**
 * QIMO OS — Decision Kernel v1 单测
 *
 * 运行：
 *   npx tsx scripts/test-os-kernel.ts
 *
 * 覆盖：
 *   A. 五类裁决：hub_view / internal_access / handoff_granted / insufficient_permission / unknown_system
 *   B. fail-closed（空角色 / 无 user）
 *   C. scope 限缩透传（handoff tokenScope）
 *   D. 单脑证明：hub / handoff 只调 Kernel，不含分散策略逻辑
 */

import { readFileSync } from 'fs';
import { OSDecisionKernel } from '../lib/os/kernel';
import { resolveVisibleSystems } from '../lib/os/registry';

let pass = 0, fail = 0;
const failures: string[] = [];
function assert(cond: boolean, label: string, ctx?: string) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}${ctx ? ' — ' + ctx : ''}`); fail++; failures.push(label); }
}
function section(n: string) { console.log(`\n▶ ${n}`); }
const U = (roles: string[]) => ({ id: 'u1', email: 'a@qimoclothing.com', roles });

// ── A. 五类裁决 ──────────────────────────────────────────
section('A. 裁决类型');

const hub = OSDecisionKernel({ user: U(['sales']) });
assert(hub.allow && hub.reason === 'hub_view' && hub.entryMode === 'internal', 'hub_view（无 action）');
assert(hub.systemAccess.map((s) => s.id).sort().join() === resolveVisibleSystems(['sales']).map((s) => s.id).sort().join(),
  'systemAccess == registry 可见集（单一真源）');

const internal = OSDecisionKernel({ user: U(['sales']), action: { type: 'ENTER_SYSTEM', targetSystem: 'order' } });
assert(internal.allow && internal.reason === 'internal_access' && internal.entryMode === 'internal', 'internal_access（order/sales）');

const handoff = OSDecisionKernel({ user: U(['finance']), action: { type: 'ENTER_SYSTEM', targetSystem: 'finance' } });
assert(handoff.allow && handoff.reason === 'handoff_granted' && handoff.entryMode === 'handoff', 'handoff_granted（finance/finance）');
assert(JSON.stringify(handoff.tokenScope) === JSON.stringify(['finance.view']), 'tokenScope=[finance.view]');

const denied = OSDecisionKernel({ user: U(['sales']), action: { type: 'ENTER_SYSTEM', targetSystem: 'finance' } });
assert(!denied.allow && denied.reason === 'insufficient_permission' && denied.entryMode === 'blocked', 'insufficient_permission（finance/sales）');

const unknown = OSDecisionKernel({ user: U(['admin']), action: { type: 'ENTER_SYSTEM', targetSystem: 'nope' } });
assert(!unknown.allow && unknown.reason === 'unknown_system' && unknown.entryMode === 'blocked', 'unknown_system（fail-closed）');

// ── B. fail-closed ───────────────────────────────────────
section('B. fail-closed');
const empty = OSDecisionKernel({ user: U([]), action: { type: 'ENTER_SYSTEM', targetSystem: 'order' } });
assert(!empty.allow && empty.entryMode === 'blocked', '空角色访问 → blocked');
assert(OSDecisionKernel({ user: U([]) }).systemAccess.length === 0, '空角色 hub → 空系统');
// @ts-expect-error 故意传入畸形 user 验证不崩
const noUser = OSDecisionKernel({});
assert(noUser.systemAccess.length === 0 && noUser.reason === 'hub_view', '缺 user → 不崩，空可见');

// ── C. scope 限缩 ────────────────────────────────────────
section('C. scope 限缩');
const adminFinance = OSDecisionKernel({ user: U(['admin']), action: { type: 'ENTER_SYSTEM', targetSystem: 'finance' } });
assert(JSON.stringify(adminFinance.tokenScope) === JSON.stringify(['finance.view']), 'admin→finance tokenScope 仅 finance.view（不带全能力）');
assert(adminFinance.capabilities.length === 5, 'admin capabilities 全量（但 scope 限缩）');

// ── D. 单脑证明 ──────────────────────────────────────────
section('D. 单脑：hub/handoff 只调 Kernel');
const hubSrc = readFileSync(new URL('../app/hub/page.tsx', import.meta.url), 'utf8');
const handoffSrc = readFileSync(new URL('../app/api/os/handoff/route.ts', import.meta.url), 'utf8');

assert(hubSrc.includes('OSDecisionKernel'), 'hub 经 Kernel');
assert(!/resolveVisibleSystems|capabilitiesForRoles|canAccessSystem/.test(hubSrc), 'hub 不含分散策略函数');
assert(handoffSrc.includes('OSDecisionKernel'), 'handoff 经 Kernel');
assert(!/resolveVisibleSystems|capabilitiesForRoles|canAccessSystem/.test(handoffSrc), 'handoff 不含分散策略函数（策略全在 Kernel）');
assert(!/\.insert\(|\.update\(|\.delete\(/.test(handoffSrc), 'handoff 不写任何表');
assert(handoffSrc.includes('signBridgeSession'), 'handoff 边缘铸 BridgeSession');

// ─────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(48)}`);
console.log(`通过 ${pass} · 失败 ${fail}`);
if (fail > 0) { console.log('失败项：\n  - ' + failures.join('\n  - ')); process.exit(1); }
console.log('✅ 全部通过');
