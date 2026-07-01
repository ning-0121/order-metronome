/**
 * 采购执行链 B3a 单测 — 纯逻辑
 * 运行：npx tsx scripts/test-procurement-execution.ts
 * 桥(item→执行行)· 状态推进(只进不退)· 核销派生(需求/下单/收货/消耗/尾货)。
 */

import {
  buildExecutionLineRow, canGenerateExecution, resolveReceivingStatus, resolveOrderedStatus, deriveFulfillment,
  type ProcItem,
} from '../lib/services/procurement-execution';

let pass = 0, fail = 0;
const failures: string[] = [];
function assert(cond: boolean, label: string, ctx?: string) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}${ctx ? ' — ' + ctx : ''}`); fail++; failures.push(label); }
}
function section(n: string) { console.log(`\n▶ ${n}`); }

const item = (o: Partial<ProcItem>): ProcItem => ({
  id: 'i1', order_id: 'o1', consolidation_key: 'k1', status: 'confirmed', ...o,
});

section('buildExecutionLineRow(item → 执行行)');
const row = buildExecutionLineRow(item({
  material_name: '面料X', specification: '75D', category: 'fabric', unit: 'KG', purchase_unit: 'KG',
  final_purchase_qty: 320, suggested_purchase_qty: 300, confirmed_supplier_name: '供A', unit_price: 12.5,
}), 'u1');
assert(row.procurement_item_id === 'i1', '挂 procurement_item_id');
assert(row.order_id === 'o1', '带 order_id');
assert(row.material_name === '面料X', 'material_name 映射');
assert(row.ordered_qty === 320, 'ordered_qty = final_purchase_qty(优先)', `${row.ordered_qty}`);
assert(row.unit_price === 12.5, 'unit_price = 大货底价');
assert(row.supplier_name === '供A', 'supplier_name = confirmed_supplier_name');
assert(row.ordered_by === 'u1', 'ordered_by');

const row2 = buildExecutionLineRow(item({ material_name: null, suggested_purchase_qty: 100, unit: 'M' }), 'u1');
assert(row2.ordered_qty === 100, 'final 缺 → 退回 suggested', `${row2.ordered_qty}`);
assert(row2.material_name === 'k1', 'material_name 缺 → 退回 consolidation_key');
assert(row2.ordered_unit === 'M', 'purchase_unit 缺 → 退回 unit');

const row3 = buildExecutionLineRow(item({ material_name: 'Y' }), 'u1'); // 无 final 无 suggested
assert(row3.ordered_qty === 0, '两个量都缺 → 0(NOT NULL 兜底)');

section('canGenerateExecution(仅 confirmed)');
assert(canGenerateExecution(item({ status: 'confirmed' })) === true, 'confirmed → 可生成');
assert(canGenerateExecution(item({ status: 'draft' })) === false, 'draft → 不可');
assert(canGenerateExecution(item({ status: 'reviewing' })) === false, 'reviewing → 不可');
assert(canGenerateExecution(item({ status: 'ordered' })) === false, 'ordered(已生成过) → 不可');

section('resolveReceivingStatus(收货推进,只进不退)');
assert(resolveReceivingStatus('ordered', 0, 100) === 'ordered', '未收 → 不动(保持 ordered)');
assert(resolveReceivingStatus('ordered', 40, 100) === 'partially_received', '部分收 → partially_received');
assert(resolveReceivingStatus('ordered', 100, 100) === 'completed', '收齐 → completed');
assert(resolveReceivingStatus('ordered', 120, 100) === 'completed', '超收 → completed');
assert(resolveReceivingStatus('completed', 40, 100) === 'completed', '不退:completed 不因部分回退');
assert(resolveReceivingStatus('confirmed', 50, 100) === 'partially_received', 'confirmed 也可被收货推进');
assert(resolveReceivingStatus('draft', 100, 100) === 'draft', 'draft 未确认 → 不自动动');
assert(resolveReceivingStatus('reviewing', 100, 100) === 'reviewing', 'reviewing → 不自动动');
assert(resolveReceivingStatus('closed', 50, 100) === 'closed', 'closed → 不动');

section('resolveOrderedStatus(下单推进)');
assert(resolveOrderedStatus('confirmed') === 'ordered', 'confirmed → ordered');
assert(resolveOrderedStatus('ordered') === 'ordered', 'ordered → 不变');
assert(resolveOrderedStatus('partially_received') === 'partially_received', '更高状态不回退');
assert(resolveOrderedStatus('draft') === 'draft', 'draft 未确认 → 不动');

section('deriveFulfillment(核销派生)');
const items: ProcItem[] = [
  item({ id: 'i1', consolidation_key: 'k1', material_name: '面料X', unit: 'KG', total_required_qty: 300, status: 'partially_received' }),
  item({ id: 'i2', consolidation_key: 'k2', material_name: '辅料Y', unit: 'PCS', total_required_qty: 500, status: 'ordered' }),
];
const lines = [
  { procurement_item_id: 'i1', ordered_qty: 320, received_qty: 200 },
  { procurement_item_id: 'i1', ordered_qty: 0, received_qty: 50 }, // 拆单第二行
  { procurement_item_id: 'i2', ordered_qty: 500, received_qty: 0 },
  { procurement_item_id: null, ordered_qty: 999, received_qty: 999 }, // 手工老行(无 item) → 不计
];
const leftover = [
  { material_key: 'k1', received: 250, consumed: 180 }, // k1 领用 180
  { material_key: 'k2', received: 0, consumed: 0 },
];
const f = deriveFulfillment(items, lines, leftover);
const f1 = f.find((r) => r.procurement_item_id === 'i1')!;
assert(f1.required === 300, 'i1 需求 300');
assert(f1.ordered === 320, 'i1 下单 = 320+0(拆单求和,忽略无 item 的老行)', `${f1.ordered}`);
assert(f1.received === 250, 'i1 收货 = 库存派生 250', `${f1.received}`);
assert(f1.consumed === 180, 'i1 消耗 180');
assert(f1.leftover === 70, 'i1 尾货 = 250 − 180 = 70', `${f1.leftover}`);
const f2 = f.find((r) => r.procurement_item_id === 'i2')!;
assert(f2.ordered === 500 && f2.received === 0 && f2.leftover === 0, 'i2 下单500/未收/无尾货');

console.log(`\n${'─'.repeat(48)}`);
console.log(`通过 ${pass} · 失败 ${fail}`);
if (fail > 0) { console.log('失败项：\n  - ' + failures.join('\n  - ')); process.exit(1); }
console.log('✅ 全部通过');
