/**
 * QIMO OS Phase A+ 单测 — Capability Graph + Registry v2 + BridgeSession
 *
 * 运行：
 *   npx tsx scripts/test-os-bridge.ts
 *
 * 覆盖：
 *   A. Capability graph（角色→能力）
 *   B. Registry v2 治理 + 能力驱动可见性（含"与 Phase A 行为等价"回归）
 *   C. BridgeSession sign/verify + scope 限缩 + jti 重放 + 篡改/过期/错 aud
 *   D. 静态隔离：handoff 铸令牌不写业务表
 */

import { readFileSync } from 'fs';
import { capabilitiesForRoles } from '../lib/os/capabilities';
import {
  SYSTEM_REGISTRY, resolveVisibleSystems, canAccessSystem, scopeForSystem, resolveEntry, getSystem,
} from '../lib/os/registry';
import { visibleSystemsForRoles } from '../lib/os/systems';
import { signBridgeSession, verifyBridgeSession, BRIDGE_TTL_SEC, type BridgeSession } from '../lib/os/bridge';
import { isJtiSeen, rememberJti, _resetJtiStore } from '../lib/os/jtiStore';

let pass = 0, fail = 0;
const failures: string[] = [];
function assert(cond: boolean, label: string, ctx?: string) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}${ctx ? ' — ' + ctx : ''}`); fail++; failures.push(label); }
}
function section(n: string) { console.log(`\n▶ ${n}`); }
const sortedIds = (a: { id: string }[]) => a.map((s) => s.id).sort().join(',');

// ── A. Capability graph ──────────────────────────────────
section('A. Capability Graph');
assert([...capabilitiesForRoles(['sales'])].sort().join() === 'client.develop,order.execute', 'sales → client.develop + order.execute');
assert([...capabilitiesForRoles(['finance'])].sort().join() === 'finance.view,procurement.manage', 'finance → finance.view + procurement.manage');
assert(capabilitiesForRoles(['admin']).size === 5, 'admin → 全 5 能力');
assert(capabilitiesForRoles([]).size === 0, '空角色 → 无能力');
assert(capabilitiesForRoles(['unknown_role']).size === 0, '未知角色 → 无能力');

// ── B. Registry v2 + 能力驱动可见性 ──────────────────────
section('B. Registry v2 治理 + 可见性');
assert(SYSTEM_REGISTRY.length === 5, '注册表 5 系统');
assert(SYSTEM_REGISTRY.every((s) => !!s.owner_team && !!s.entry_policy && !!s.security_level), '治理字段齐（owner_team/entry_policy/security_level）');
assert(getSystem('finance')!.security_level === 'sensitive', 'finance = sensitive');
assert(getSystem('finance')!.entry_policy === 'handoff_required', 'finance = handoff_required');
assert(getSystem('order')!.entry_policy === 'direct', 'order = direct');

// 回归：registry 驱动 == Phase A visibleSystemsForRoles（行为不漂移）
for (const roles of [['admin'], ['sales'], ['finance'], ['qc'], ['merchandiser'], ['procurement'], []]) {
  assert(
    sortedIds(resolveVisibleSystems(roles)) === sortedIds(visibleSystemsForRoles(roles)),
    `可见性等价 Phase A：[${roles.join(',')}]`,
    `${sortedIds(resolveVisibleSystems(roles))} vs ${sortedIds(visibleSystemsForRoles(roles))}`,
  );
}
assert(!resolveVisibleSystems(['sales']).some((s) => s.id === 'finance'), 'sales 不见 sensitive 财务');
assert(canAccessSystem('finance', ['finance']) && !canAccessSystem('finance', ['sales']), 'canAccess finance 门控正确');
assert(resolveEntry(getSystem('order')!) === '/dashboard', 'direct → 应用路径');
assert(resolveEntry(getSystem('finance')!) === '/api/os/handoff?target=finance', 'handoff → 跳转端点');

// ── C. BridgeSession ─────────────────────────────────────
section('C. BridgeSession token');
const SECRET = 'bridge-secret';
const now = 2_000_000;
function mint(aud: string, roles: string[], overrides: Partial<BridgeSession> = {}): BridgeSession {
  return {
    session_id: 'sess-1', sub: 'a@qimoclothing.com', roles,
    capabilities: [...capabilitiesForRoles(roles)], aud, iat: now, exp: now + BRIDGE_TTL_SEC,
    jti: 'jti-1', nonce: 'n-1', scope: scopeForSystem(aud, roles), ...overrides,
  };
}

const sess = mint('finance', ['finance']);
const token = signBridgeSession(sess, SECRET);
const v = verifyBridgeSession(token, SECRET, 'finance', now + 5);
assert(v.ok === true, 'roundtrip 验签通过');
assert(v.ok && v.session.jti === 'jti-1', 'session 还原（jti）');

// scope 限缩：finance 令牌只带 finance.view，不带用户其它能力（procurement.manage 不进 scope）
assert(sess.scope.join() === 'finance.view', 'scope 限缩 = finance.view（per-system 隔离）');
assert(sess.capabilities.includes('procurement.manage') && !sess.scope.includes('procurement.manage'),
  'scope 不外溢：capabilities 有 procurement.manage 但 finance scope 不含');

// admin 进 araos：scope 只 client.develop（不把全部能力带进 araos）
const adminAraos = mint('araos', ['admin']);
assert(adminAraos.scope.join() === 'client.develop', 'admin→araos scope 仅 client.develop（不带全能力）');

// 拒绝面
assert(verifyBridgeSession(token, 'wrong', 'finance', now + 5).ok === false, '错密钥 → 拒');
assert(verifyBridgeSession(token, SECRET, 'araos', now + 5).ok === false, '错 aud → 拒（防跨目标重放）');
assert(verifyBridgeSession(token, SECRET, 'finance', now + 999).ok === false, '过期 → 拒');
const tampered = token.slice(0, token.indexOf('.') + 1) + 'deadbeef';
assert(verifyBridgeSession(tampered, SECRET, 'finance', now + 5).ok === false, '篡改 → 拒');
assert(verifyBridgeSession('garbage', SECRET, 'finance', now + 5).ok === false, '畸形 → 拒');

// jti 重放：首次过，remember 后再验即拒
_resetJtiStore();
const first = verifyBridgeSession(token, SECRET, 'finance', now + 5, { jtiSeen: (j) => isJtiSeen(j, now + 5) });
assert(first.ok === true, 'jti 首次验证通过');
rememberJti(sess.jti, sess.exp, now + 5);
const replay = verifyBridgeSession(token, SECRET, 'finance', now + 5, { jtiSeen: (j) => isJtiSeen(j, now + 5) });
assert(!replay.ok && replay.reason === 'jti_replay', 'jti 重放 → 拒（reason=jti_replay）');

// ── D. 静态隔离 ──────────────────────────────────────────
section('D. handoff 隔离');
const handoffSrc = readFileSync(new URL('../app/api/os/handoff/route.ts', import.meta.url), 'utf8');
assert(!/\.insert\(|\.update\(|\.delete\(/.test(handoffSrc), 'handoff 不写任何表');
assert(!/quoter_quotes|quote_line|quote_version_snapshot|customer_po|from\(['"]orders['"]\)/.test(handoffSrc),
  'handoff 不碰 Quote/PO/Order 表');
assert(/signBridgeSession/.test(handoffSrc), 'handoff 铸 BridgeSession');

// ─────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(48)}`);
console.log(`通过 ${pass} · 失败 ${fail}`);
if (fail > 0) { console.log('失败项：\n  - ' + failures.join('\n  - ')); process.exit(1); }
console.log('✅ 全部通过');
