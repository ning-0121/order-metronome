/**
 * 采购 P3 A 单测 — 跨订单 netting 聚合（纯）
 *
 * 运行：npx tsx scripts/test-procurement-p3.ts
 * 覆盖：跨订单同物料聚合 · 单位区分 · 排序 · order_ref 双号 · 隔离。
 */

import { readFileSync } from 'fs';
import { aggregateLinesByKey, type NettingLine } from '../lib/services/netting';

let pass = 0, fail = 0;
const failures: string[] = [];
function assert(cond: boolean, label: string, ctx?: string) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}${ctx ? ' — ' + ctx : ''}`); fail++; failures.push(label); }
}
function section(n: string) { console.log(`\n▶ ${n}`); }

const lines: NettingLine[] = [
  { id: 'l1', order_id: 'o1', order_no: 'A', internal_order_no: 'IA', material_name: '面料X', specification: '160g', category: 'fabric', ordered_qty: 500, ordered_unit: 'KG' },
  { id: 'l2', order_id: 'o2', order_no: 'B', internal_order_no: 'IB', material_name: '面料X', specification: '160g', category: 'fabric', ordered_qty: 800, ordered_unit: 'KG' },
  { id: 'l3', order_id: 'o1', order_no: 'A', internal_order_no: 'IA', material_name: '辅料Y', category: 'trim', ordered_qty: 100, ordered_unit: 'PCS' },
  { id: 'l4', order_id: 'o1', order_no: 'A', internal_order_no: 'IA', material_name: '面料X', specification: '160g', category: 'fabric', ordered_qty: 200, ordered_unit: 'M' }, // 同料不同单位
];

const groups = aggregateLinesByKey(lines);

section('聚合');
assert(groups.length === 3, '3 组（面料X-KG / 面料X-M / 辅料Y）', `实际 ${groups.length}`);

const kg = groups[0]; // 排序:跨订单优先
assert(kg.material_name === '面料X' && kg.unit === 'KG', '首组 = 面料X KG（跨订单排前）');
assert(kg.order_count === 2, '跨 2 单', `${kg.order_count}`);
assert(kg.total_qty === 1300, '总量 500+800=1300', `${kg.total_qty}`);
assert(kg.line_ids.length === 2 && kg.line_ids.includes('l1') && kg.line_ids.includes('l2'), '归 l1+l2');
assert(kg.contributors.length === 2, '2 个贡献订单');
assert(kg.contributors[0].order_ref === 'IA', 'order_ref = internal_order_no（双号）');

section('单位区分');
const mGroup = groups.find((g) => g.material_name === '面料X' && g.unit === 'M');
assert(!!mGroup, '面料X-M 独立成组（单位不同 → 不同 key）');
assert(mGroup!.order_count === 1 && mGroup!.total_qty === 200, '面料X-M：1 单 200');

section('单订单组仍出现');
const y = groups.find((g) => g.material_name === '辅料Y');
assert(!!y && y!.order_count === 1 && y!.total_qty === 100, '辅料Y：1 单 100');

section('排序：跨订单在前');
assert(groups[0].order_count >= groups[1].order_count, '跨订单组排在前');

section('边界');
assert(aggregateLinesByKey([]).length === 0, '空 → 空');

section('隔离');
const netSrc = readFileSync(new URL('../lib/services/netting.ts', import.meta.url), 'utf8');
assert(!/supabase|createClient|\.insert\(|\.update\(/.test(netSrc), 'netting.ts 纯逻辑（无 DB）');
const actSrc = readFileSync(new URL('../app/actions/procurement-netting.ts', import.meta.url), 'utf8');
assert(!/\.insert\(|\.update\(|\.delete\(/.test(actSrc), 'netting action 只读（不写库）');

console.log(`\n${'─'.repeat(48)}`);
console.log(`通过 ${pass} · 失败 ${fail}`);
if (fail > 0) { console.log('失败项：\n  - ' + failures.join('\n  - ')); process.exit(1); }
console.log('✅ 全部通过');
