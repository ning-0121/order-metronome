/**
 * 采购 P2a 单测 — 审批风险闸（纯逻辑）
 *
 * 运行：npx tsx scripts/test-procurement-p2a.ts
 * 覆盖：五类风险触发 + 边界 + 标准单快路径 + topRequiredScope + 组合。
 */

import { evaluateProcurementApproval, topRequiredScope, PROC_APPROVAL_THRESHOLDS, type ProcApprovalInput } from '../lib/procurement/approval';

let pass = 0, fail = 0;
const failures: string[] = [];
function assert(cond: boolean, label: string, ctx?: string) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}${ctx ? ' — ' + ctx : ''}`); fail++; failures.push(label); }
}
function section(n: string) { console.log(`\n▶ ${n}`); }

const base: ProcApprovalInput = {
  totalAmount: 10000, lines: [{ unit_price: 10, price_baseline: 10 }],
  supplierNetDays: 90, isNewSupplier: false, orderBudget: null,
};

// ── 标准单快路径 ─────────────────────────────────────────
section('标准单 → 零审批');
const std = evaluateProcurementApproval(base);
assert(std.needsApproval === false && std.reasons.length === 0, '标准单 needsApproval=false');

// ── 大额 ─────────────────────────────────────────────────
section('大额（≥5万）');
assert(evaluateProcurementApproval({ ...base, totalAmount: 50000 }).reasons.includes('large_amount'), '=5万 → 触发(>=)');
assert(!evaluateProcurementApproval({ ...base, totalAmount: 49999 }).reasons.includes('large_amount'), '49999 → 不触发');
const large = evaluateProcurementApproval({ ...base, totalAmount: 60000 });
assert(large.requiredBy.includes('procurement') && large.requiredBy.includes('finance'), '大额 → 采购+财务');

// ── 价格偏差 >5% ─────────────────────────────────────────
section('价格偏差 >5%');
assert(evaluateProcurementApproval({ ...base, lines: [{ unit_price: 10.6, price_baseline: 10 }] }).reasons.includes('price_variance'), '6% → 触发');
assert(!evaluateProcurementApproval({ ...base, lines: [{ unit_price: 10.5, price_baseline: 10 }] }).reasons.includes('price_variance'), '5% 整 → 不触发(严格>)');
assert(!evaluateProcurementApproval({ ...base, lines: [{ unit_price: null, price_baseline: 10 }] }).reasons.includes('price_variance'), '无底价/建议价 → 不判');

// ── 新供应商 ─────────────────────────────────────────────
section('新供应商');
const ns = evaluateProcurementApproval({ ...base, isNewSupplier: true });
assert(ns.reasons.includes('new_supplier') && ns.requiredBy.includes('procurement'), '新供应商 → 采购经理');

// ── 非标账期（供应商账期 <60）───────────────────────────
section('非标账期 <60 天');
assert(evaluateProcurementApproval({ ...base, supplierNetDays: 59 }).reasons.includes('non_standard_terms'), '59天 → 触发');
assert(!evaluateProcurementApproval({ ...base, supplierNetDays: 60 }).reasons.includes('non_standard_terms'), '60天 → 不触发(严格<)');
assert(evaluateProcurementApproval({ ...base, supplierNetDays: 30 }).requiredBy.includes('finance'), '短账期 → 财务');
assert(!evaluateProcurementApproval({ ...base, supplierNetDays: null }).reasons.includes('non_standard_terms'), '账期未知 → 不判');

// ── 超预算 ───────────────────────────────────────────────
section('超预算');
assert(evaluateProcurementApproval({ ...base, totalAmount: 20000, orderBudget: 10000 }).reasons.includes('over_budget'), '超预算 → 触发');
assert(!evaluateProcurementApproval({ ...base, totalAmount: 20000, orderBudget: null }).reasons.includes('over_budget'), '无预算 → 跳过');

// ── topRequiredScope ─────────────────────────────────────
section('topRequiredScope（单签取最高）');
assert(topRequiredScope(['procurement', 'finance']) === 'finance', 'finance 覆盖 procurement');
assert(topRequiredScope(['procurement']) === 'procurement', '仅采购 → procurement');
assert(topRequiredScope([]) === null, '空 → null');

// ── 组合 ─────────────────────────────────────────────────
section('组合触发');
const combo = evaluateProcurementApproval({ totalAmount: 60000, lines: [{ unit_price: 12, price_baseline: 10 }], supplierNetDays: 30, isNewSupplier: true, orderBudget: 50000 });
assert(combo.reasons.length === 5, '五类全中', combo.reasons.join(','));
assert(combo.requiredBy.includes('procurement') && combo.requiredBy.includes('finance'), '组合 → 采购+财务');

// 阈值可见
assert(PROC_APPROVAL_THRESHOLDS.LARGE_AMOUNT === 50000 && PROC_APPROVAL_THRESHOLDS.PRICE_VARIANCE_PCT === 5 && PROC_APPROVAL_THRESHOLDS.SUPPLIER_STANDARD_NET_DAYS === 60, '阈值=5万/5%/60天');

console.log(`\n${'─'.repeat(48)}`);
console.log(`通过 ${pass} · 失败 ${fail}`);
if (fail > 0) { console.log('失败项：\n  - ' + failures.join('\n  - ')); process.exit(1); }
console.log('✅ 全部通过');
