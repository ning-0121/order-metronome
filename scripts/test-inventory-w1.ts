/**
 * 库存 W1 单测 — 领料/退料对余额影响 + 接线/门控
 * 运行：npx tsx scripts/test-inventory-w1.ts
 */

import { readFileSync } from 'fs';
import { aggregateInventoryBalance } from '../lib/services/inventory';

let pass = 0, fail = 0;
const failures: string[] = [];
function assert(cond: boolean, label: string, ctx?: string) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}${ctx ? ' — ' + ctx : ''}`); fail++; failures.push(label); }
}
function section(n: string) { console.log(`\n▶ ${n}`); }

// ── 领料/退料对余额 ──────────────────────────────────────
section('领料/退料对余额');
const bal = aggregateInventoryBalance([
  { material_key: 'k', material_name: 'X', unit: 'KG', qty: 500 }, // receipt
  { material_key: 'k', qty: -200 },                                // issue 领料200 → 存 −200
  { material_key: 'k', qty: 50 },                                  // return 退料50 → +50
]);
assert(bal[0].on_hand === 350, '500 − 领200 + 退50 = 350', `${bal[0].on_hand}`);
assert(aggregateInventoryBalance([{ material_key: 'k', qty: -100 }])[0].on_hand === -100, '先领后入 → 负库存 −100(v1 允许)');

// ── 接线 / 门控 静态断言 ─────────────────────────────────
section('接线 / 门控');
const invSrc = readFileSync(new URL('../app/actions/inventory.ts', import.meta.url), 'utf8');
assert(/recordInventoryIssue/.test(invSrc) && /recordInventoryReturn/.test(invSrc), 'issue/return action 已建');
assert(/CAN_ISSUE_MATERIAL/.test(invSrc), '领料/退料受 CAN_ISSUE_MATERIAL 门控');
assert(/txnType === 'issue' \? -q : q/.test(invSrc), '领料存负、退料存正');

const rolesSrc = readFileSync(new URL('../lib/domain/roles.ts', import.meta.url), 'utf8');
assert(/CAN_ISSUE_MATERIAL:\s*\[/.test(rolesSrc), 'roles 有 CAN_ISSUE_MATERIAL 组');

const procSrc = readFileSync(new URL('../app/actions/procurement.ts', import.meta.url), 'utf8');
const hooks = (procSrc.match(/recordInventoryReceipt/g) || []).length;
assert(hooks >= 2, '两条收货路径都挂了入库(recordReceipt + recordGoodsReceipt),修 W0 洞', `hooks=${hooks}`);

console.log(`\n${'─'.repeat(48)}`);
console.log(`通过 ${pass} · 失败 ${fail}`);
if (fail > 0) { console.log('失败项：\n  - ' + failures.join('\n  - ')); process.exit(1); }
console.log('✅ 全部通过');
