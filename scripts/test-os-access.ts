/**
 * QIMO OS Unified Access — Phase A 单测
 *
 * 运行：
 *   npx tsx scripts/test-os-access.ts
 *
 * 覆盖：
 *   A. visibleSystemsForRoles / canEnterSystem / resolveHref（分权显示）
 *   B. 短时 token sign/verify（roundtrip + 篡改/过期/错 aud 拒绝）
 *   C. 静态隔离：OS 层不写业务表、不碰 Quote/PO/Order/finance/araos 代码
 */

import { readFileSync } from 'fs';
import { visibleSystemsForRoles, canEnterSystem, resolveHref, OS_SYSTEMS } from '../lib/os/systems';
import { signClaims, verifyToken, type OsHandoffClaims } from '../lib/os/token';

let pass = 0, fail = 0;
const failures: string[] = [];
function assert(cond: boolean, label: string, ctx?: string) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}${ctx ? ' — ' + ctx : ''}`); fail++; failures.push(label); }
}
function section(n: string) { console.log(`\n▶ ${n}`); }
const ids = (arr: { id: string }[]) => arr.map((s) => s.id).sort();

// ── A. 分权显示 ──────────────────────────────────────────
section('A. 角色可见性');

assert(JSON.stringify(ids(visibleSystemsForRoles(['admin']))) === JSON.stringify(['araos','finance','order','procurement','production'].sort()),
  'admin → 全部 5 个系统');

const salesSees = ids(visibleSystemsForRoles(['sales']));
assert(salesSees.includes('araos') && salesSees.includes('order'), 'sales → 见 araos + order');
assert(!salesSees.includes('finance'), 'sales → 不见财务（敏感系统隐藏）');
assert(!salesSees.includes('production'), 'sales → 不见生产');

const financeSees = ids(visibleSystemsForRoles(['finance']));
assert(financeSees.includes('finance') && financeSees.includes('procurement'), 'finance → 见财务 + 采购');
assert(!financeSees.includes('araos') && !financeSees.includes('order'), 'finance → 不见 araos/order');

assert(ids(visibleSystemsForRoles(['qc'])).join() === 'production', 'qc → 仅生产');
assert(visibleSystemsForRoles([]).length === 0, '空角色 → 空');
assert(visibleSystemsForRoles(null).length === 0, 'null 角色 → 空');

assert(canEnterSystem('finance', ['finance']) === true, 'canEnter finance(finance)=true');
assert(canEnterSystem('finance', ['sales']) === false, 'canEnter finance(sales)=false');
assert(canEnterSystem('finance', ['admin']) === true, 'canEnter finance(admin)=true');
assert(canEnterSystem('nope', ['admin']) === false, '未知系统=false');

assert(resolveHref(OS_SYSTEMS.find((s) => s.id === 'order')!) === '/dashboard', 'internal → 应用路径');
assert(resolveHref(OS_SYSTEMS.find((s) => s.id === 'finance')!) === '/api/os/handoff?target=finance', 'external → handoff');

// ── B. token ─────────────────────────────────────────────
section('B. 短时 token');
const now = 1_000_000;
const claims: OsHandoffClaims = { sub: 'a@qimoclothing.com', roles: ['finance'], aud: 'finance', iat: now, exp: now + 90, nonce: 'n1' };
const SECRET = 'test-secret';
const token = signClaims(claims, SECRET);

const good = verifyToken(token, SECRET, 'finance', now + 10);
assert(good.ok === true, 'roundtrip 验签通过');
assert(good.ok && good.claims.sub === 'a@qimoclothing.com', 'claims 还原正确');

assert(verifyToken(token, 'wrong-secret', 'finance', now + 10).ok === false, '错密钥 → 拒');
assert(verifyToken(token, SECRET, 'araos', now + 10).ok === false, '错 aud → 拒（防跨目标重放）');
assert(verifyToken(token, SECRET, 'finance', now + 200).ok === false, '过期 → 拒');
const tampered = token.slice(0, token.indexOf('.') + 1) + 'deadbeef';
assert(verifyToken(tampered, SECRET, 'finance', now + 10).ok === false, '篡改签名 → 拒');
assert(verifyToken('garbage', SECRET, 'finance', now + 10).ok === false, '畸形 token → 拒');
const wrongAud = verifyToken(token, SECRET, 'araos', now + 10);
assert(!wrongAud.ok && wrongAud.reason === 'aud_mismatch', "reason='aud_mismatch'");

// ── C. 源码隔离 ──────────────────────────────────────────
section('C. OS 层隔离断言');
const handoffSrc = readFileSync(new URL('../app/api/os/handoff/route.ts', import.meta.url), 'utf8');
assert(!/\.insert\(|\.update\(|\.delete\(/.test(handoffSrc), 'handoff 不写任何表（只读 profiles）');
assert(!/quoter_quotes|quote_line|quote_version_snapshot|customer_po|from\(['"]orders['"]\)/.test(handoffSrc),
  'handoff 不碰 Quote/PO/Order 表');
const systemsSrc = readFileSync(new URL('../lib/os/systems.ts', import.meta.url), 'utf8');
assert(!/\.from\(/.test(systemsSrc), 'systems.ts 无 DB 访问（纯配置/逻辑）');
const tokenSrc = readFileSync(new URL('../lib/os/token.ts', import.meta.url), 'utf8');
assert(!/supabase|@\/lib\/supabase/.test(tokenSrc), 'token.ts 无 supabase/DB 依赖（纯逻辑）');

// ─────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(48)}`);
console.log(`通过 ${pass} · 失败 ${fail}`);
if (fail > 0) { console.log('失败项：\n  - ' + failures.join('\n  - ')); process.exit(1); }
console.log('✅ 全部通过');
