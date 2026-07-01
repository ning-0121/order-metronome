/**
 * 库存 W0 单测 — 派生余额 + 增量入库（纯）
 * 运行：npx tsx scripts/test-inventory-w0.ts
 */

import { readFileSync } from 'fs';
import { aggregateInventoryBalance, computeReceiptDelta, materialKeyForLine, type InvTxn } from '../lib/services/inventory';

let pass = 0, fail = 0;
const failures: string[] = [];
function assert(cond: boolean, label: string, ctx?: string) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}${ctx ? ' — ' + ctx : ''}`); fail++; failures.push(label); }
}
function section(n: string) { console.log(`\n▶ ${n}`); }

// ── 派生余额 ─────────────────────────────────────────────
section('派生余额（Σ 流水）');
const txns: InvTxn[] = [
  { material_key: 'k1', material_name: '面料X', unit: 'KG', qty: 500 },   // 入库
  { material_key: 'k1', material_name: '面料X', unit: 'KG', qty: 300 },   // 再入库
  { material_key: 'k1', material_name: '面料X', unit: 'KG', qty: -200 },  // 领料
  { material_key: 'k2', material_name: '辅料Y', unit: 'PCS', qty: 100 },
];
const bal = aggregateInventoryBalance(txns);
assert(bal.length === 2, '2 个物料余额');
const k1 = bal.find((b) => b.material_key === 'k1')!;
assert(k1.on_hand === 600, 'k1 在库 500+300−200=600', `${k1.on_hand}`);
assert(k1.material_name === '面料X' && k1.unit === 'KG', 'k1 名/单位');
assert(bal.find((b) => b.material_key === 'k2')!.on_hand === 100, 'k2 = 100');
assert(aggregateInventoryBalance([]).length === 0, '空 → 空');

// 负库存(领超)也显示
assert(aggregateInventoryBalance([{ material_key: 'k', qty: 100 }, { material_key: 'k', qty: -150 }])[0].on_hand === -50, '领超 → 负库存 −50');

// ── 增量入库 delta ───────────────────────────────────────
section('增量入库 delta');
assert(computeReceiptDelta(500, 0) === 500, '首次收货 500 → +500');
assert(computeReceiptDelta(800, 500) === 300, '更正到 800(已入500)→ +300');
assert(computeReceiptDelta(0, 800) === -800, '取消(0,已入800)→ −800');
assert(computeReceiptDelta(500, 500) === 0, '无变化 → 0(不生成流水)');

// ── material_key 口径 ────────────────────────────────────
section('material_key');
const kA = materialKeyForLine({ material_name: '面料X', specification: '160g', category: 'fabric', ordered_unit: 'KG' });
const kA2 = materialKeyForLine({ material_name: '面料X', specification: '160g', category: 'fabric', ordered_unit: 'KG' });
const kB = materialKeyForLine({ material_name: '面料X', specification: '160g', category: 'fabric', ordered_unit: 'M' });
assert(kA === kA2, '同物料同单位 → 同 key');
assert(kA !== kB, '不同单位 → 不同 key');

// ── 隔离 ─────────────────────────────────────────────────
section('隔离');
const src = readFileSync(new URL('../lib/services/inventory.ts', import.meta.url), 'utf8');
assert(!/supabase|createClient|\.insert\(|\.update\(/.test(src), 'inventory.ts 纯逻辑(无 DB)');

console.log(`\n${'─'.repeat(48)}`);
console.log(`通过 ${pass} · 失败 ${fail}`);
if (fail > 0) { console.log('失败项：\n  - ' + failures.join('\n  - ')); process.exit(1); }
console.log('✅ 全部通过');
