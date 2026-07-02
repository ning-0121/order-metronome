/**
 * 物料目录 SC-P1 单测 — convertUnit(纯)
 * 运行：npx tsx scripts/test-material-catalog.ts
 * 同单位×1 / 正向×factor / 反向÷factor / 无路径→null。
 */

import { convertUnit, type UomRow } from '../lib/services/material-catalog';

let pass = 0, fail = 0;
const failures: string[] = [];
function assert(cond: boolean, label: string, ctx?: string) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}${ctx ? ' — ' + ctx : ''}`); fail++; failures.push(label); }
}
function section(n: string) { console.log(`\n▶ ${n}`); }

const rows: UomRow[] = [
  { from_unit: 'kg', to_unit: 'g', factor: 1000 },
  { from_unit: 'yard', to_unit: 'm', factor: 0.9144 },
];

section('convertUnit');
assert(convertUnit(2, 'kg', 'kg', rows) === 2, '同单位 → 原值');
assert(convertUnit(2, 'kg', 'g', rows) === 2000, '正向 2kg → 2000g');
assert(convertUnit(3000, 'g', 'kg', rows) === 3, '反向 3000g → 3kg(÷factor)');
assert(convertUnit(1, 'yard', 'm', rows) === 0.914, '正向 1yard → 0.914m(round3)', `${convertUnit(1, 'yard', 'm', rows)}`);
assert(convertUnit(1, 'KG', ' g ', rows) === 1000, '大小写/空白无关');
assert(convertUnit(5, 'kg', 'pcs', rows) === null, '无换算路径 → null(不臆造)');
assert(convertUnit(5, '', 'kg', rows) === null, '空单位 → null');
assert(convertUnit(5, 'kg', 'g', []) === null, '无换算行 → null');

section('边界');
assert(convertUnit(0, 'kg', 'g', rows) === 0, '0 → 0');
const badFactor: UomRow[] = [{ from_unit: 'a', to_unit: 'b', factor: 0 }];
assert(convertUnit(5, 'a', 'b', badFactor) === null, 'factor≤0 跳过 → null');

console.log(`\n${'─'.repeat(48)}`);
console.log(`通过 ${pass} · 失败 ${fail}`);
if (fail > 0) { console.log('失败项：\n  - ' + failures.join('\n  - ')); process.exit(1); }
console.log('✅ 全部通过');
