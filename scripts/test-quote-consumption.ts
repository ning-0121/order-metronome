/**
 * Consumption Firewall 单元测试 — getApprovedQuoteForCompare 的 3 态状态机
 *
 * 运行：
 *   npx tsx scripts/test-quote-consumption.ts
 *
 * 覆盖（纯逻辑层 resolveCompareBasis / blockedBasis，无 DB/auth）：
 *   ① approved     → consumable=true（唯一）
 *   ② provisional  → consumable=false（有快照未审批 / 审批快照异常缺失）
 *   ③ none         → consumable=false（无快照，硬阻断）
 *   quote_not_found / blockedBasis
 *   红线：consumable=true ⟹ snapshot 非 null 且 basis=approved；priceFloor/currency 可空透传
 *
 * 注：DB 读取（真实 getApprovedQuoteForCompare 落库）需 auth+DB，由代码审查 + 后续手验覆盖。
 */

import { resolveCompareBasis, blockedBasis } from '../lib/quoter/consumption';
import type { QuoteSnapshot } from '../lib/quoter/types';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function assert(cond: boolean, label: string, ctx?: string) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}${ctx ? ' — ' + ctx : ''}`); fail++; failures.push(label); }
}

function section(name: string) { console.log(`\n▶ ${name}`); }

const snap = (version: number): { version: number; snapshot: QuoteSnapshot } => ({
  version,
  snapshot: { version, header: { id: 'q-1', customer_id: 'cust-1' }, lines: [{ id: 'l-1', line_no: 1 }] },
});

// ──────────────────────────────────────────────────────────
// ① APPROVED
// ──────────────────────────────────────────────────────────

section('① APPROVED — consumable=true（唯一）');
const a = resolveCompareBasis('q-1', { approved_version: 2, price_floor: 5.5, currency: 'USD' }, snap(2), null);
assert(a.consumable === true, 'consumable=true');
assert(a.basis === 'approved', "basis='approved'");
assert(a.isApproved === true, 'isApproved=true');
assert(a.snapshotVersion === 2, 'snapshotVersion=approved_version');
assert(a.snapshot !== null && a.snapshot.version === 2, 'snapshot 透传（v2）');
assert(a.priceFloor === 5.5, 'priceFloor 信封透传');
assert(a.currency === 'USD', 'currency 信封透传');

// ──────────────────────────────────────────────────────────
// ② PROVISIONAL
// ──────────────────────────────────────────────────────────

section('② PROVISIONAL — 有快照未审批');
const p = resolveCompareBasis('q-1', { approved_version: null, price_floor: null, currency: 'USD' }, null, snap(3));
assert(p.consumable === false, 'consumable=false');
assert(p.basis === 'provisional', "basis='provisional'");
assert(p.isApproved === false, 'isApproved=false');
assert(p.snapshotVersion === 3, 'snapshotVersion=最新版');
assert(p.snapshot !== null, 'snapshot 提供（只读预览）');
assert(p.priceFloor === null, 'priceFloor 可空透传');

section('② PROVISIONAL — 生产级守卫：approved_version 有值但审批快照缺失');
const degrade = resolveCompareBasis('q-1', { approved_version: 2, price_floor: 5.5, currency: 'USD' }, null, snap(2));
assert(degrade.consumable === false, '审批快照缺失 → 不 consumable（防污染 PO）');
assert(degrade.basis === 'provisional', '降级为 provisional');
assert(degrade.reason === 'approved_snapshot_missing', "reason='approved_snapshot_missing'");

// ──────────────────────────────────────────────────────────
// ③ NONE
// ──────────────────────────────────────────────────────────

section('③ NONE — 无任何冻结快照，硬阻断');
const n = resolveCompareBasis('q-1', { approved_version: null, price_floor: 4.0, currency: 'RMB' }, null, null);
assert(n.consumable === false, 'consumable=false');
assert(n.basis === 'none', "basis='none'");
assert(n.snapshot === null, 'snapshot=null（NEVER fallback 到 live quote）');
assert(n.snapshotVersion === null, 'snapshotVersion=null');
assert(n.priceFloor === 4.0 && n.currency === 'RMB', '信封仍透传');

section('quote_not_found / blockedBasis');
const nf = resolveCompareBasis('q-1', null, snap(1), snap(1));
assert(nf.consumable === false && nf.basis === 'none', 'envelope=null → none');
assert(nf.reason === 'quote_not_found', "reason='quote_not_found'");
const b = blockedBasis('q-1', 'unauthenticated');
assert(b.consumable === false && b.snapshot === null, 'blockedBasis → 不可消费、无快照');

// ──────────────────────────────────────────────────────────
// 红线不变量
// ──────────────────────────────────────────────────────────

section('红线不变量（跨所有态）');
const all = [a, p, degrade, n, nf, b];
assert(all.every((r) => r.consumable === false || r.snapshot !== null), 'consumable=true ⟹ snapshot 非 null');
assert(all.every((r) => r.consumable === false || r.basis === 'approved'), 'consumable=true ⟹ basis=approved');
assert(all.every((r) => r.consumable === false || r.isApproved === true), 'consumable=true ⟹ isApproved=true');
assert(all.filter((r) => r.consumable).length === 1, '六态样本中恰 1 个 consumable（仅 approved）');

// ──────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(48)}`);
console.log(`通过 ${pass} · 失败 ${fail}`);
if (fail > 0) { console.log('失败项：\n  - ' + failures.join('\n  - ')); process.exit(1); }
console.log('✅ 全部通过');
