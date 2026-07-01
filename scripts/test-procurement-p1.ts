/**
 * 采购 P1 单测 — 供应商字段分工 + 采购单底价屏蔽
 *
 * 运行：npx tsx scripts/test-procurement-p1.ts
 */

import { readFileSync } from 'fs';
import { pickEditableSupplierFields, maskFloorForLines, SUPPLIER_BUSINESS_FIELDS, SUPPLIER_FINANCE_FIELDS } from '../lib/procurement/purchaseOrder';

let pass = 0, fail = 0;
const failures: string[] = [];
function assert(c: boolean, label: string, ctx?: string) {
  if (c) { console.log(`  ✅ ${label}`); pass++; } else { console.log(`  ❌ ${label}${ctx ? ' — ' + ctx : ''}`); fail++; failures.push(label); }
}
function section(n: string) { console.log(`\n▶ ${n}`); }

const fullInput = {
  name: '某面料厂', address: '绍兴', phone: '138', contact_name: '王', main_category: 'fabric',
  payment_method: '电汇', net_days: 30, bank_info: '工行xxx', tax_id: '9133xxx',
};

// ── A. 字段分工 ──────────────────────────────────────────
section('A. 供应商字段分工');
const basicOnly = pickEditableSupplierFields(fullInput, true, false);
assert(SUPPLIER_BUSINESS_FIELDS.every((f) => f in basicOnly), '业务角色 → 拿到全部业务字段');
assert(SUPPLIER_FINANCE_FIELDS.every((f) => !(f in basicOnly)), '业务角色 → 拿不到财务字段');

const financeOnly = pickEditableSupplierFields(fullInput, false, true);
assert(SUPPLIER_FINANCE_FIELDS.every((f) => f in financeOnly), '财务角色 → 拿到全部财务字段');
assert(SUPPLIER_BUSINESS_FIELDS.every((f) => !(f in financeOnly)), '财务角色 → 拿不到业务字段');

const both = pickEditableSupplierFields(fullInput, true, true);
assert(Object.keys(both).length === SUPPLIER_BUSINESS_FIELDS.length + SUPPLIER_FINANCE_FIELDS.length, 'admin(双权) → 全字段');
assert(Object.keys(pickEditableSupplierFields(fullInput, false, false)).length === 0, '无权 → 空');

// ── B. 底价屏蔽 ──────────────────────────────────────────
section('B. 采购单底价屏蔽');
const lines = [{ id: 'l1', material_name: '主面料', price_baseline: 45, unit_price: 42.5, ordered_amount: 4250, difference_amount: 0 }];

const forProc = maskFloorForLines(lines, true);
assert('unit_price' in forProc[0], '采购/财务 → 见底价 unit_price');
assert('price_baseline' in forProc[0], '采购 → 见建议价 price_baseline');

const forSales = maskFloorForLines(lines, false);
assert(!('unit_price' in forSales[0]), '业务 → 无 unit_price(底价被剥)');
assert(!('ordered_amount' in forSales[0]) && !('difference_amount' in forSales[0]), '业务 → 派生金额也剥(防反推底价)');
assert('price_baseline' in forSales[0], '业务 → 仍见建议价 price_baseline');
assert('material_name' in forSales[0], '业务 → 非价字段保留');
// 原数组不被改
assert('unit_price' in lines[0], 'mask 不改原数据(纯函数)');

// ── C. 红线静态 ──────────────────────────────────────────
section('C. action 层用纯逻辑');
const poSrc = readFileSync(new URL('../app/actions/purchase-orders.ts', import.meta.url), 'utf8');
assert(poSrc.includes('maskFloorForLines'), 'getPurchaseOrder 经 maskFloorForLines 屏蔽底价');
assert(/CAN_SEE_PROCUREMENT_FLOOR/.test(poSrc), '按 CAN_SEE_PROCUREMENT_FLOOR 判可见');
const supSrc = readFileSync(new URL('../app/actions/suppliers.ts', import.meta.url), 'utf8');
assert(supSrc.includes('pickEditableSupplierFields'), 'supplier 写入经字段分工过滤');
assert(!/from\(['"]factories['"]\)/.test(supSrc + poSrc), '不把 factories 当供应商(用 suppliers 表)');

console.log(`\n${'─'.repeat(48)}`);
console.log(`通过 ${pass} · 失败 ${fail}`);
if (fail > 0) { console.log('失败项：\n  - ' + failures.join('\n  - ')); process.exit(1); }
console.log('✅ 全部通过');
