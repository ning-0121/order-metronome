/**
 * 库存 W2 单测 — 真尾货 computeOrderLeftover（纯）
 * 运行：npx tsx scripts/test-inventory-w2.ts
 * 真尾货 = received − consumed(issue/scrap − return);adjust 不计;领料没录 → 尾货=received。
 */

import { computeOrderLeftover, type LeftoverTxn } from '../lib/services/inventory';

let pass = 0, fail = 0;
const failures: string[] = [];
function assert(cond: boolean, label: string, ctx?: string) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}${ctx ? ' — ' + ctx : ''}`); fail++; failures.push(label); }
}
function section(n: string) { console.log(`\n▶ ${n}`); }

const txns: LeftoverTxn[] = [
  { material_key: 'k1', material_name: '面料X', unit: 'KG', txn_type: 'receipt', qty: 500 },
  { material_key: 'k1', txn_type: 'issue', qty: -200 },  // 领料 200
  { material_key: 'k1', txn_type: 'return', qty: 50 },   // 退料 50
  { material_key: 'k2', material_name: '辅料Y', unit: 'PCS', txn_type: 'receipt', qty: 100 }, // 只收未领
  { material_key: 'k3', material_name: 'Z', unit: 'M', txn_type: 'receipt', qty: 20 },
  { material_key: 'k3', txn_type: 'scrap', qty: -10 },   // 报废 10 → 计入消耗
  { material_key: 'k4', material_name: 'W', unit: 'KG', txn_type: 'receipt', qty: 30 },
  { material_key: 'k4', txn_type: 'adjust', qty: 5 },    // 盘点 → 不计入订单尾货
];
const rows = computeOrderLeftover(txns);

section('真尾货');
const k1 = rows.find((r) => r.material_key === 'k1')!;
assert(k1.received === 500, 'k1 收货 500');
assert(k1.consumed === 150, 'k1 消耗 = 领200 − 退50 = 150', `${k1.consumed}`);
assert(k1.leftover === 350, 'k1 尾货 = 500 − 150 = 350');

const k2 = rows.find((r) => r.material_key === 'k2')!;
assert(k2.consumed === 0 && k2.leftover === 100, 'k2 只收未领 → 消耗0、尾货=收货100(领料没录的后果)');

const k3 = rows.find((r) => r.material_key === 'k3')!;
assert(k3.consumed === 10 && k3.leftover === 10, 'k3 报废计入消耗 → 消耗10、尾货10');

const k4 = rows.find((r) => r.material_key === 'k4')!;
assert(k4.consumed === 0 && k4.leftover === 30, 'k4 盘点(adjust)不计入尾货 → 消耗0、尾货30');

section('边界');
assert(computeOrderLeftover([]).length === 0, '空 → 空');
const neg = computeOrderLeftover([{ material_key: 'k', txn_type: 'receipt', qty: 10 }, { material_key: 'k', txn_type: 'issue', qty: -15 }]);
assert(neg[0].leftover === -5, '消耗>收货 → 尾货负(−5,超领/未入)');

console.log(`\n${'─'.repeat(48)}`);
console.log(`通过 ${pass} · 失败 ${fail}`);
if (fail > 0) { console.log('失败项：\n  - ' + failures.join('\n  - ')); process.exit(1); }
console.log('✅ 全部通过');
