/**
 * Customer PO 绑定层单测（Phase D）
 *
 * 运行：
 *   npx tsx scripts/test-po.ts
 *
 * 覆盖：
 *   A. evaluatePoCreation 纯门控（consumable / customer 一致 / 防御）
 *   B. 静态隔离断言：PO 层源码不访问 quote_line、不直读 live quoter_quotes、不重算/不碰 RAG
 *
 * 注：createPO / getPOView 真实落库需 auth+DB，由结构门禁（FK）+ 代码审查 + 手验覆盖；
 *     此处测纯门控 + 源码级隔离契约。
 */

import { readFileSync } from 'fs';
import { evaluatePoCreation } from '../lib/po/types';
import type { CompareBasis } from '../lib/quoter/consumption';
import type { QuoteSnapshot } from '../lib/quoter/types';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function assert(cond: boolean, label: string, ctx?: string) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}${ctx ? ' — ' + ctx : ''}`); fail++; failures.push(label); }
}
function section(name: string) { console.log(`\n▶ ${name}`); }

// fixtures ───────────────────────────────────────────────
const snapshot = (customerId: string): QuoteSnapshot => ({
  version: 2,
  header: { id: 'q-1', customer_id: customerId },
  lines: [{ id: 'l-1', line_no: 1 }],
});
const approved = (customerId: string): CompareBasis => ({
  consumable: true, basis: 'approved', quoteId: 'q-1', snapshotVersion: 2,
  isApproved: true, snapshot: snapshot(customerId), priceFloor: 5, currency: 'USD',
});
const provisional: CompareBasis = {
  consumable: false, basis: 'provisional', quoteId: 'q-1', snapshotVersion: 3,
  isApproved: false, snapshot: snapshot('cust-1'), priceFloor: null, currency: 'USD',
};
const none: CompareBasis = {
  consumable: false, basis: 'none', quoteId: 'q-1', snapshotVersion: null,
  isApproved: false, snapshot: null, priceFloor: null, currency: null,
};

// ── A. 纯门控 ────────────────────────────────────────────
section('A. evaluatePoCreation 门控');

const okDecision = evaluatePoCreation(approved('cust-1'), 'cust-1');
assert(okDecision.ok === true, 'consumable + 客户一致 → 允许创建');
assert(okDecision.snapshotVersion === 2, '锁定 snapshotVersion=2');

const mismatch = evaluatePoCreation(approved('cust-1'), 'cust-2');
assert(mismatch.ok === false, '客户不一致 → 拒绝');
assert(mismatch.error === 'CUSTOMER_MISMATCH', "error='CUSTOMER_MISMATCH'");

const provDecision = evaluatePoCreation(provisional, 'cust-1');
assert(provDecision.ok === false, 'provisional（未审批）→ 拒绝');
assert(provDecision.error === 'QUOTE_NOT_CONSUMABLE:provisional', 'error 标注 provisional');

const noneDecision = evaluatePoCreation(none, 'cust-1');
assert(noneDecision.ok === false, 'none（无快照）→ 拒绝');
assert(noneDecision.error === 'QUOTE_NOT_CONSUMABLE:none', 'error 标注 none');

// 防御：consumable=true 但 snapshot 缺失（firewall 不变量本应保证非空）
const brokenSnap: CompareBasis = { ...approved('cust-1'), snapshot: null };
assert(evaluatePoCreation(brokenSnap, 'cust-1').error === 'SNAPSHOT_MISSING', '快照缺失防御 → SNAPSHOT_MISSING');

// 红线：不 consumable 时永不返回 ok
assert([provDecision, noneDecision, mismatch].every((d) => d.ok === false), '任一未通过门控 → ok=false');

// ── B. 源码级隔离契约 ────────────────────────────────────
section('B. PO 层源码隔离断言');
const poSrc = readFileSync(new URL('../app/actions/customer-po.ts', import.meta.url), 'utf8');

assert(!/from\(['"]quote_line['"]\)/.test(poSrc), 'customer-po.ts 不查询 quote_line 表');
assert(!/from\(['"]quoter_quotes['"]\)/.test(poSrc), 'customer-po.ts 不直接读 quoter_quotes（live）');
assert(!/generateQuoteWithRAG|previewQuote|lib\/quoter\/api|lib\/quoter\/(cmt|fabric|trim)/.test(poSrc),
  '不重算 / 不碰 RAG·成本引擎');
assert(poSrc.includes('getApprovedQuoteForCompare'), 'createPO 经消费闸门 getApprovedQuoteForCompare');
assert(poSrc.includes("from('customer_po')") || poSrc.includes('from("customer_po")'), '写入目标 = customer_po');
assert(poSrc.includes('quote_version_snapshot'), 'getPOView 读冻结快照 quote_version_snapshot');
assert(!/orders?\b/.test(poSrc.replace(/\/\*[\s\S]*?\*\//g, '')), 'PO 层不触 Order');

const typesSrc = readFileSync(new URL('../lib/po/types.ts', import.meta.url), 'utf8');
assert(!/\.from\(/.test(typesSrc), 'lib/po/types.ts 无 DB 访问（纯类型/逻辑）');

// ──────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(48)}`);
console.log(`通过 ${pass} · 失败 ${fail}`);
if (fail > 0) { console.log('失败项：\n  - ' + failures.join('\n  - ')); process.exit(1); }
console.log('✅ 全部通过');
