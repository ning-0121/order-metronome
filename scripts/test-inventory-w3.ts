/**
 * 库存 W3 单测 — MRP 扣库存(flag)匹配 + 扣减
 * 运行：npx tsx scripts/test-inventory-w3.ts
 *
 * 两件事:
 *  1) onHandForMaterial:按 名+单位 best-effort 匹配在库量(flag 开时喂给 MRP)。
 *  2) computeMaterialRequirement:inventoryQty>0 → 净采购量按量下调(证明 flag 开的扣减);
 *     inventoryQty=0(flag 默认关)→ 与现状逐字节一致。
 */

import { onHandForMaterial, aggregateInventoryBalance, type InvTxn } from '../lib/services/inventory';
import { computeMaterialRequirement } from '../lib/services/mrp';

let pass = 0, fail = 0;
const failures: string[] = [];
function assert(cond: boolean, label: string, ctx?: string) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}${ctx ? ' — ' + ctx : ''}`); fail++; failures.push(label); }
}
function section(n: string) { console.log(`\n▶ ${n}`); }

// ── 1. onHandForMaterial 匹配 ──
section('onHandForMaterial(名+单位 best-effort)');
const txns: InvTxn[] = [
  { material_key: 'k1', material_name: '面料X', unit: 'KG', qty: 500 },
  { material_key: 'k1', material_name: '面料X', unit: 'KG', qty: -120 }, // 领掉 → k1 余 380
  { material_key: 'k2', material_name: '面料X', unit: 'KG', qty: 100 },  // 另一规格同名同单位 → 也算面料X/KG
  { material_key: 'k3', material_name: '面料X', unit: '米', qty: 999 },  // 单位不同 → 不算 KG
  { material_key: 'k4', material_name: '辅料Y', unit: 'PCS', qty: 60 },
];
const bal = aggregateInventoryBalance(txns);
assert(onHandForMaterial(bal, '面料X', 'KG') === 480, '面料X/KG = 380 + 100 = 480(跨 key 求和,忽略规格)', `${onHandForMaterial(bal, '面料X', 'KG')}`);
assert(onHandForMaterial(bal, ' 面料x ', 'kg') === 480, '大小写/空白无关');
assert(onHandForMaterial(bal, '面料X', '米') === 999, '单位不同独立计');
assert(onHandForMaterial(bal, '辅料Y', 'PCS') === 60, '辅料Y/PCS = 60');
assert(onHandForMaterial(bal, '不存在', 'KG') === 0, '未匹配 → 0');
assert(onHandForMaterial([], '面料X', 'KG') === 0, '空余额 → 0');

// ── 2. MRP 扣库存(flag 开=喂真在库 / 关=0) ──
section('computeMaterialRequirement 扣库存');
const base = {
  material: { material_name: '面料X', material_type: 'fabric', material_code: null, unit: 'KG', qty_per_piece: 0.5, loss_rate: 0 },
  po_quantity: 1000, // gross = 0.5 * 1000 = 500
  stageAnchors: { factory_date: '2026-09-01' },
  today: '2026-07-02',
};
const off = computeMaterialRequirement({ ...base, inventoryQty: 0, reuseQty: 0 });   // flag 关(现状)
const on = computeMaterialRequirement({ ...base, inventoryQty: 480, reuseQty: 0 });   // flag 开,喂 480

assert(off.gross_requirement === 500, 'gross = 0.5 × 1000 = 500', `${off.gross_requirement}`);
assert(off.inventory_deduct === 0, 'flag 关:扣库存 = 0(现状不变)');
assert(off.net_purchase_qty === 500, 'flag 关:净采购 = 500(= gross,无扣减)', `${off.net_purchase_qty}`);
assert(on.inventory_deduct === 480, 'flag 开:扣库存 = 480');
assert(on.net_purchase_qty === 20, 'flag 开:净采购 = 500 − 480 = 20', `${on.net_purchase_qty}`);
assert((off.net_purchase_qty as number) - (on.net_purchase_qty as number) === 480, '扣减量 = 喂入的在库量');

section('边界:在库 ≥ 需求 → 净采购不为负');
const over = computeMaterialRequirement({ ...base, inventoryQty: 9999, reuseQty: 0 });
assert((over.net_purchase_qty as number) <= 500 && (over.net_purchase_qty as number) >= 0, '超量在库 → 净采购不为负', `${over.net_purchase_qty}`);

console.log(`\n${'─'.repeat(48)}`);
console.log(`通过 ${pass} · 失败 ${fail}`);
if (fail > 0) { console.log('失败项：\n  - ' + failures.join('\n  - ')); process.exit(1); }
console.log('✅ 全部通过');
