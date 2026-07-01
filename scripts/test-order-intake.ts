/**
 * QIMO OS — Order Intake Convergence v1 单测
 *
 * 运行：
 *   npx tsx scripts/test-order-intake.ts
 *
 * 覆盖：
 *   A. Router 分流（PO / LEGACY / BLOCKED）
 *   B. Legacy 保留（手填流不被新系统门控）
 *   C. 快照继承（逐字，含 fail-closed 版本一致）
 *   D. 不重算（无 RAG/成本引擎；行值 = 快照原值）
 *   E. Kernel 权限集成 + 纯层隔离（不写库）
 */

import { readFileSync } from 'fs';
import { OrderIntakeRouter } from '../lib/order/intake-router';
import { buildOrderDraftFromPO, buildOrderFromPO, type CustomerPoLike } from '../lib/order/from-po';
import type { QuoteSnapshot } from '../lib/quoter/types';
import type { CompareBasis } from '../lib/quoter/consumption';

let pass = 0, fail = 0;
const failures: string[] = [];
function assert(cond: boolean, label: string, ctx?: string) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}${ctx ? ' — ' + ctx : ''}`); fail++; failures.push(label); }
}
function section(n: string) { console.log(`\n▶ ${n}`); }
const U = (roles: string[]) => ({ id: 'u1', email: 'a@qimoclothing.com', roles });

// ── A. Router 分流 ───────────────────────────────────────
section('A. Router 分流');
const manual = OrderIntakeRouter({ source: 'manual', user: U([]) });
assert(manual.mode === 'LEGACY' && manual.allow, 'manual → LEGACY');

// order 系统可进角色（merchandiser 有 order.execute）
const po = OrderIntakeRouter({ source: 'po', user: U(['merchandiser']), po: { customerPoId: 'po-1', quoteId: 'q-1' } });
assert(po.mode === 'PO' && po.handler === 'from-po' && po.allow, 'po + 有权 → PO');

const noRef = OrderIntakeRouter({ source: 'po', user: U(['merchandiser']) });
assert(noRef.mode === 'BLOCKED' && noRef.reason === 'po_ref_missing', 'po 缺引用 → BLOCKED');

// finance 无 order.execute → Kernel 拒 → BLOCKED
const denied = OrderIntakeRouter({ source: 'po', user: U(['finance']), po: { customerPoId: 'po-1' } });
assert(denied.mode === 'BLOCKED' && denied.reason.startsWith('kernel_denied'), 'po 无权 → BLOCKED(kernel_denied)');

// ── B. Legacy 保留 ───────────────────────────────────────
section('B. Legacy 保留');
assert(OrderIntakeRouter({ source: 'manual', user: U([]) }).allow, '空角色也能走 manual（legacy 不被门控）');
assert(OrderIntakeRouter({ source: 'manual', user: U(['finance']) }).mode === 'LEGACY', 'finance 走 manual 仍 LEGACY');

// ── C. 快照继承 ──────────────────────────────────────────
section('C. 快照继承');
const snapshot: QuoteSnapshot = {
  version: 3,
  header: { id: 'q-1', customer_id: 'cust-1', currency: 'USD' },
  lines: [{ id: 'l-1', line_no: 1, quoted_price_per_piece: 5.95, quantity: 1200 }],
};
const poRow: CustomerPoLike = { id: 'po-1', po_number: 'PO-777', customer_id: 'cust-1', quote_id: 'q-1', quote_snapshot_version: 3 };
const draft = buildOrderDraftFromPO(poRow, snapshot, { priceFloor: 5.5 });

assert(draft.source === 'PO', 'source=PO');
assert(draft.customer_id === 'cust-1', '继承 customer_id');
assert(draft.customer_po_number === 'PO-777', '继承 po_number');
assert(draft.origin_quote_id === 'q-1', '继承 origin_quote_id（引用）');
assert(draft.customer_po_id === 'po-1', '继承 customer_po_id（binding）');
assert(draft.quote_snapshot_version === 3 && draft.approved_version === 3, '继承 snapshot/approved 版=3');
assert(draft.price_floor === 5.5, '继承 price_floor');
assert(draft.currency === 'USD', '继承 currency（快照 header）');

// fail-closed：版本不一致抛错
let threw = false;
try { buildOrderDraftFromPO({ ...poRow, quote_snapshot_version: 2 }, snapshot); } catch (e: any) { threw = e.message === 'snapshot_version_mismatch'; }
assert(threw, '版本不一致 → 抛 snapshot_version_mismatch');

// ── D. 不重算 ────────────────────────────────────────────
section('D. 不重算');
assert(draft.lines === snapshot.lines, 'lines 逐字继承（同引用，未重建）');
assert((draft.lines[0] as any).quoted_price_per_piece === 5.95, '价格 = 快照原值（未重算）');
const fromPoSrc = readFileSync(new URL('../lib/order/from-po.ts', import.meta.url), 'utf8');
assert(!/generateQuoteWithRAG|lib\/quoter\/api|lib\/quoter\/(cmt|fabric|trim)/.test(fromPoSrc), 'from-po 不 import RAG/成本引擎');
assert(!/\.insert\(|\.update\(|\.delete\(|supabase/.test(fromPoSrc), 'from-po 纯映射，不写库');

// ── E. Kernel 集成 + 隔离 ────────────────────────────────
section('E. Kernel 集成 + 隔离');
const routerSrc = readFileSync(new URL('../lib/order/intake-router.ts', import.meta.url), 'utf8');
assert(routerSrc.includes('OSDecisionKernel'), 'router 经 Kernel 判准入');
assert(!/\.insert\(|\.update\(|\.delete\(|supabase/.test(routerSrc), 'router 纯分发，不写库');

// ── F. buildOrderFromPO — approval 硬门 ──────────────────
section('F. buildOrderFromPO approval 硬门');
const approvedBasis = (v = 3): CompareBasis => ({
  consumable: true, basis: 'approved', quoteId: 'q-1', snapshotVersion: v, isApproved: true,
  snapshot: { version: v, header: { customer_id: 'cust-1', customer_name: 'ACME', currency: 'USD' }, lines: [{ id: 'l-1', line_no: 1, quoted_price_per_piece: 5.95, quantity: 1200 }] },
  priceFloor: 5.5, currency: 'USD',
});
const provisionalBasis: CompareBasis = { ...approvedBasis(3), consumable: false, basis: 'provisional', isApproved: false };
const noneBasis: CompareBasis = { consumable: false, basis: 'none', quoteId: 'q-1', snapshotVersion: null, isApproved: false, snapshot: null, priceFloor: null, currency: null };

const okDraft = buildOrderFromPO(poRow, approvedBasis(3));
assert(okDraft.source === 'PO' && okDraft.customer_name === 'ACME', 'approved → 派生草稿（含 customer_name 继承）');
assert(okDraft.quote_snapshot_version === 3 && okDraft.price_floor === 5.5, '继承 snapshot 版 + price_floor');

function throwsWith(fn: () => void, msg: string): boolean { try { fn(); return false; } catch (e: any) { return e.message === msg; } }
assert(throwsWith(() => buildOrderFromPO(poRow, provisionalBasis), 'snapshot_not_approved'), 'provisional（未审批）→ HARD FAIL');
assert(throwsWith(() => buildOrderFromPO(poRow, noneBasis), 'snapshot_not_approved'), 'none（无快照）→ HARD FAIL');
assert(throwsWith(() => buildOrderFromPO({ ...poRow, quote_snapshot_version: 2 }, approvedBasis(3)), 'snapshot_version_mismatch'), '版本漂移 → HARD FAIL');

// ── G. PO 路径隔离（复用 legacy，不改 Quote/PO/Kernel）────
section('G. order-from-po 隔离');
const fromPoActionSrc = readFileSync(new URL('../app/actions/order-from-po.ts', import.meta.url), 'utf8');
assert(/import\s*\{[^}]*createOrder[^}]*\}\s*from\s*'@\/app\/actions\/orders'/.test(fromPoActionSrc), '复用既有 createOrder（不重写建单管线）');
assert(fromPoActionSrc.includes('getApprovedQuoteForCompare'), '经消费闸门取 snapshot 真相');
assert(fromPoActionSrc.includes('OrderIntakeRouter') && fromPoActionSrc.includes('buildOrderFromPO'), '走 Router + 映射器');
assert(!/from\(['"]quoter_quotes['"]\)\s*[^)]*\.(insert|update|delete)|from\(['"]quote_line['"]\)|from\(['"]customer_po['"]\)\s*[^)]*\.(insert|update|delete)/.test(fromPoActionSrc),
  '不改 Quote/PO 表（只读 customer_po，只写 orders 绑定）');
assert(fromPoActionSrc.includes("from('orders')") && fromPoActionSrc.includes("source: 'PO'"), '仅对 orders 附加 PO 绑定');

// ─────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(48)}`);
console.log(`通过 ${pass} · 失败 ${fail}`);
if (fail > 0) { console.log('失败项：\n  - ' + failures.join('\n  - ')); process.exit(1); }
console.log('✅ 全部通过');
