/**
 * Procurement Kernel 单测(ADR-005 确定性内核)
 * 运行：npx tsx scripts/test-procurement-kernel.ts
 * shortageTruth(net=demand−available) · sourcingTruth(价/期/履约排序) · executionTruth(紧急优先)。
 */

import {
  shortageTruth, sourcingTruth, executionTruth,
  type ShortageInput, type SupplierInput, type ScoredSupplier,
} from '../lib/services/procurement-kernel';

let pass = 0, fail = 0;
const failures: string[] = [];
function assert(cond: boolean, label: string, ctx?: string) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}${ctx ? ' — ' + ctx : ''}`); fail++; failures.push(label); }
}
function section(n: string) { console.log(`\n▶ ${n}`); }

section('shortageTruth(net = demand − available)');
const items: ShortageInput[] = [
  { material_key: 'k1', material_name: '面料X', unit: 'KG', demand: 1000, available: 300 }, // 缺 700
  { material_key: 'k2', material_name: '辅料Y', unit: 'PCS', demand: 200, available: 500 },  // 盈余 300
  { material_key: 'k3', material_name: 'Z', unit: 'M', demand: 100, available: 100 },        // 刚好
];
const short = shortageTruth(items);
const k1 = short.find(s => s.material_key === 'k1')!;
assert(k1.net === 700 && k1.toBuy === 700 && k1.hasShortage, 'k1 缺口 700');
assert(k1.coverage === 0.3, 'k1 齐料率 0.3');
const k2 = short.find(s => s.material_key === 'k2')!;
assert(k2.net === -300 && k2.toBuy === 0 && k2.surplus === 300 && !k2.hasShortage, 'k2 盈余300不买');
assert(k2.coverage === 1, 'k2 齐料率封顶 1');
const k3 = short.find(s => s.material_key === 'k3')!;
assert(k3.toBuy === 0 && !k3.hasShortage, 'k3 刚好不缺');

section('sourcingTruth(价/期/履约,确定性排序)');
const suppliers: SupplierInput[] = [
  { supplier_id: 'A', supplier_name: '供A', unit_price: 10, lead_days: 20 }, // 最便宜,慢
  { supplier_id: 'B', supplier_name: '供B', unit_price: 12, lead_days: 5 },  // 贵一点,最快
  { supplier_id: 'C', supplier_name: '供C', unit_price: 11, lead_days: 12, is_preferred: true },
];
const ranked = sourcingTruth(suppliers); // 默认权重 price .5 lead .3 rel .2
assert(ranked.length === 3 && ranked[0].rank === 1, '3 家排名');
// A: price 1.0*.5 + lead 0*.3 + .5*.2 = .6;B: price 0*.5 + lead 1*.3 + .5*.2 = .4;C: price .5*.5 + lead .533*.3 + .5*.2=.51
assert(ranked[0].supplier_id === 'A', 'A 最优(最便宜,价权重高)', ranked.map(r => `${r.supplier_id}:${r.score}`).join(' '));
assert(ranked[0].priceScore === 1 && ranked[0].leadScore === 0, 'A 价满分期0分');
const leadHeavy = sourcingTruth(suppliers, { weights: { price: 0.1, lead: 0.8, reliability: 0.1 } });
assert(leadHeavy[0].supplier_id === 'B', '交期权重高 → B(最快)最优');
section('sourcing 边界');
assert(sourcingTruth([]).length === 0, '空 → 空');
const noPrice = sourcingTruth([{ supplier_id: 'X' }, { supplier_id: 'Y', unit_price: 5, lead_days: 3 }]);
assert(noPrice[0].supplier_id === 'Y', '缺价/期 → 该维 0 分,有数据者胜');
const tie = sourcingTruth([{ supplier_id: 'M', unit_price: 10, lead_days: 10 }, { supplier_id: 'N', unit_price: 10, lead_days: 10, is_preferred: true }]);
assert(tie[0].supplier_id === 'N', '同分 → 首选优先');

section('executionTruth(紧急优先 + 建议供应商)');
const sourcingByKey = new Map<string, ScoredSupplier[]>([
  ['k1', ranked],
]);
const timing = new Map<string, string>([['k1', 'late']]);
const steps = executionTruth(short, sourcingByKey, timing);
assert(steps.length === 1, '只 k1 有缺口 → 1 步(k2盈余/k3刚好不出步)');
assert(steps[0].material_key === 'k1' && steps[0].toBuy === 700, '步骤=买 k1 700');
assert(steps[0].urgency === 'urgent', 'timing=late → urgent');
assert(steps[0].supplier?.supplier_id === 'A', '建议供应商=排名第一 A');
assert(steps[0].reason.includes('缺口 700'), 'reason 含可解释算式');
const noTiming = executionTruth(short, sourcingByKey);
assert(noTiming[0].urgency === 'normal', '无 timing → normal');

section('紧急排序');
const many = shortageTruth([
  { material_key: 'a', demand: 10, available: 0 },
  { material_key: 'b', demand: 20, available: 0 },
]);
const st = executionTruth(many, new Map(), new Map([['a', 'late'], ['b', 'on_time']]));
assert(st[0].material_key === 'a', 'urgent(a) 排在 normal(b) 前');

console.log(`\n${'─'.repeat(48)}`);
console.log(`通过 ${pass} · 失败 ${fail}`);
if (fail > 0) { console.log('失败项：\n  - ' + failures.join('\n  - ')); process.exit(1); }
console.log('✅ 全部通过');
