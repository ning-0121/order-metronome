/**
 * 采购 P2b 单测 — 供应商/采购单 → 财务同步 payload（纯）
 *
 * 运行：npx tsx scripts/test-procurement-p2b.ts
 * 覆盖：payload 字段映射 + 缺省 null + order_refs 回退 + 钩子安全（不阻塞主链）。
 */

import { readFileSync } from 'fs';
import { buildSupplierSyncPayload, buildPurchaseOrderSyncPayload } from '../lib/integration/finance-sync';

let pass = 0, fail = 0;
const failures: string[] = [];
function assert(cond: boolean, label: string, ctx?: string) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}${ctx ? ' — ' + ctx : ''}`); fail++; failures.push(label); }
}
function section(n: string) { console.log(`\n▶ ${n}`); }

// ── A. supplier payload ──────────────────────────────────
section('A. supplier.upserted payload');
const sup = buildSupplierSyncPayload({
  id: 's-1', supplier_code: 'SUP001', name: 'ACME 面料', main_category: 'fabric',
  payment_method: 'T/T', net_days: 60, bank_info: 'BOC ...', tax_id: '91xxxx', status: 'active', updated_at: 't1',
});
assert(sup.supplier_id === 's-1', 'id → supplier_id');
assert(sup.name === 'ACME 面料', 'name');
assert(sup.payment_method === 'T/T' && sup.net_days === 60 && sup.tax_id === '91xxxx', '财务字段透传（应付主体用）');
assert(sup.main_category === 'fabric', 'main_category');

const supMin = buildSupplierSyncPayload({ id: 's-2', name: '业务先建' });
assert(supMin.payment_method === null && supMin.net_days === null && supMin.bank_info === null && supMin.tax_id === null,
  '业务先建：财务字段缺 → null（财务补全后再 emit 幂等更新）');
assert(supMin.status === null && supMin.supplier_code === null, '缺省 → null');

// ── B. purchase order payload ────────────────────────────
section('B. purchase_order.placed payload');
const po = buildPurchaseOrderSyncPayload({
  id: 'po-1', po_no: 'PO-20260701-001', supplier_id: 's-1', total_amount: 12345.67,
  currency: 'RMB', payment_terms: 'net60', delivery_date: '2026-08-01', order_ids: ['o-1', 'o-2'], status: 'placed', updated_at: 't2',
});
assert(po.po_no === 'PO-20260701-001' && po.purchase_order_id === 'po-1', 'po_no + id');
assert(po.supplier_id === 's-1', 'supplier_id（引用应付主体）');
assert(po.total_amount === 12345.67 && po.currency === 'RMB' && po.payment_terms === 'net60', '金额/币种/账期（付款计划用）');
assert(JSON.stringify(po.order_refs) === JSON.stringify(['o-1', 'o-2']), 'order_refs ← order_ids');

const poOverride = buildPurchaseOrderSyncPayload({ id: 'po-2', po_no: 'PO-2', supplier_id: 's-1', order_ids: ['x'] }, ['ref-override']);
assert(JSON.stringify(poOverride.order_refs) === JSON.stringify(['ref-override']), 'order_refs 参数优先');
const poNoRefs = buildPurchaseOrderSyncPayload({ id: 'po-3', po_no: 'PO-3', supplier_id: 's-1' });
assert(Array.isArray(poNoRefs.order_refs) && (poNoRefs.order_refs as unknown[]).length === 0, '无订单 → []');

// ── C. 钩子安全（同步失败不阻塞主链）──────────────────────
section('C. 钩子安全');
const supSrc = readFileSync(new URL('../app/actions/suppliers.ts', import.meta.url), 'utf8');
const poSrc = readFileSync(new URL('../app/actions/purchase-orders.ts', import.meta.url), 'utf8');
assert(/try\s*\{[\s\S]*syncSupplierToFinance[\s\S]*\}\s*catch/.test(supSrc), 'suppliers 同步包 try/catch（不阻塞）');
assert(/try\s*\{[\s\S]*syncPurchaseOrderToFinance[\s\S]*\}\s*catch/.test(poSrc), 'purchase-orders 同步包 try/catch（不阻塞）');
const fsSrc = readFileSync(new URL('../lib/integration/finance-sync.ts', import.meta.url), 'utf8');
assert(!/@\/lib\/supabase|createClient\(/.test(fsSrc), 'finance-sync 无 supabase 依赖（纯推送层）');

console.log(`\n${'─'.repeat(48)}`);
console.log(`通过 ${pass} · 失败 ${fail}`);
if (fail > 0) { console.log('失败项：\n  - ' + failures.join('\n  - ')); process.exit(1); }
console.log('✅ 全部通过');
