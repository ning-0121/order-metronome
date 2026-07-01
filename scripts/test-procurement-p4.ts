/**
 * 采购 P4 A+C 单测 — 成本核算 + 订收差异（纯）
 * 运行：npx tsx scripts/test-procurement-p4.ts
 */

import { computeProcurementCostSummary, computeReceivingDiff, type CostLine } from '../lib/services/procurement-cost';

let pass = 0, fail = 0;
const failures: string[] = [];
function assert(cond: boolean, label: string, ctx?: string) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}${ctx ? ' — ' + ctx : ''}`); fail++; failures.push(label); }
}
function section(n: string) { console.log(`\n▶ ${n}`); }

// ── P4a 成本核算 ─────────────────────────────────────────
section('P4a 成本核算');
const received: CostLine[] = [
  { ordered_qty: 100, received_qty: 100, unit_price: 10, ordered_amount: 1000 }, // 收货口径 100×10=1000
  { ordered_qty: 50, received_qty: 60, unit_price: 20, ordered_amount: 1000 },  // 60×20=1200
];
const s1 = computeProcurementCostSummary(received, 2000);
assert(s1.actual_cost === 2200, '收货口径 actual=2200(100×10+60×20)', `${s1.actual_cost}`);
assert(s1.basis === 'received', "basis=received");
assert(s1.variance === 200 && s1.variance_pct === 10, '差异 +200 / +10%');

const ordered: CostLine[] = [{ ordered_qty: 100, received_qty: null, unit_price: 10, ordered_amount: 1000 }];
const s2 = computeProcurementCostSummary(ordered, null);
assert(s2.actual_cost === 1000 && s2.basis === 'ordered', '未收 → 订购口径 1000');
assert(s2.variance === null && s2.variance_pct === null, '无预算 → 差异 null');

const s3 = computeProcurementCostSummary([{ ordered_qty: 10, received_qty: 10, unit_price: 5 }, { ordered_qty: 10, received_qty: null, unit_price: 5, ordered_amount: 50 }], null);
assert(s3.basis === 'mixed', 'mixed 口径');
assert(computeProcurementCostSummary([], 100).basis === 'none', '空 → none');

// ── P4b-C 订收差异 ───────────────────────────────────────
section('P4b-C 订收差异');
const diffLines: CostLine[] = [
  { material_name: '面料A', ordered_qty: 100, received_qty: 100, unit_price: 10 }, // 相等 → skip
  { material_name: '面料B', ordered_qty: 50, received_qty: 60, unit_price: 20 },  // 超收 +10 → +200
  { material_name: '辅料C', ordered_qty: 100, received_qty: 80, unit_price: 5 },  // 短收 -20 → -100
  { material_name: '面料D', ordered_qty: 30, received_qty: null, unit_price: 8 }, // 未收 → skip
];
const d = computeReceivingDiff(diffLines);
assert(d.over.length === 1 && d.over[0].material_name === '面料B' && d.over[0].diff_amount === 200, '超收:面料B +10 → +200');
assert(d.short.length === 1 && d.short[0].diff_qty === -20 && d.short[0].diff_amount === -100, '短收:辅料C -20 → -100');
assert(d.total_diff_amount === 100, '差异合计 200-100=100', `${d.total_diff_amount}`);
assert(computeReceivingDiff([{ ordered_qty: 10, received_qty: null, unit_price: 5 }]).total_diff_amount === 0, '全未收 → 0(不算)');

console.log(`\n${'─'.repeat(48)}`);
console.log(`通过 ${pass} · 失败 ${fail}`);
if (fail > 0) { console.log('失败项：\n  - ' + failures.join('\n  - ')); process.exit(1); }
console.log('✅ 全部通过');
