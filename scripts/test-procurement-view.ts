// ============================================================
// Procurement view — 单元 + mock 测试（tsx，无框架，node:assert）
// 运行: npx tsx scripts/test-procurement-view.ts
// 覆盖: 状态派生 / 角色能力裁剪 / 视图按能力裁剪 / reorder payload / 零 DB 写
// ============================================================

import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { deriveProductionStatus } from '../lib/procurement/status';
import { resolveCapabilities } from '../lib/procurement/visibility';
import { buildProcurementView } from '../lib/procurement/procurementView';
import { buildReorderPayload } from '../lib/procurement/reorder';

let passed = 0;
function pass(name: string) {
  passed++;
  console.log(`  ✓ ${name}`);
}

// ---- mock supabase（只读；任何写方法被调用即抛 + 标记）----
function makeMock(fixtures: Record<string, unknown[]>) {
  let wrote = false;
  const guard = (m: string, table: string) => () => {
    wrote = true;
    throw new Error(`WRITE ATTEMPT: ${m} on ${table}`);
  };
  function from(table: string) {
    const rows = fixtures[table] ?? [];
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve({ data: rows, error: null }).then(onF, onR),
    };
    for (const m of ['insert', 'update', 'upsert', 'delete']) builder[m] = guard(m, table);
    return builder;
  }
  const client = { from, rpc: () => { wrote = true; throw new Error('rpc'); } };
  return { client: client as unknown as SupabaseClient, didWrite: () => wrote };
}

const FIXTURES = {
  orders: [{
    id: 'o1', order_no: 'QM-1', customer_name: 'ACME', style_no: 'S1', quantity: 1000,
    incoterm: 'FOB', etd: '2026-07-01', factory_date: '2026-06-20', lifecycle_status: 'active',
    currency: 'USD', total_amount: 12000, unit_price: 12, payment_terms: 'TT',
  }],
  order_line_items: [
    { line_no: 1, style_no: 'S1', color_cn: '红', color_en: 'Red', sizes: { S: 10, M: 20 }, qty_pcs: 30 },
  ],
  milestones: [
    { step_key: 'a', name: 'PO确认', status: 'done', sequence_number: 1 },
    { step_key: 'b', name: '采购下单', status: 'in_progress', sequence_number: 2 },
    { step_key: 'c', name: '验货', status: 'pending', sequence_number: 3 },
  ],
  procurement_line_items: [
    { material_name: '棉布', material_code: 'F1', category: 'fabric', specification: '', supplier_name: '布厂A', ordered_qty: 500, ordered_unit: 'KG', unit_price: 20, received_qty: 0, status: 'ordered' },
    { material_name: '拉链', material_code: 'T1', category: 'zipper', specification: '', supplier_name: '辅料B', ordered_qty: 1000, ordered_unit: 'pcs', unit_price: 0.5, received_qty: 1000, status: 'complete' },
  ],
  materials_bom: [] as unknown[],
};

const NOW = '2026-06-30T00:00:00.000Z';

async function main() {
  console.log('Procurement view — tests');

  // ---- status 派生 ----
  const s = deriveProductionStatus(FIXTURES.milestones as never);
  assert.equal(s.overall, 'in_progress'); pass('status overall in_progress');
  assert.equal(s.current_step_key, 'b'); pass('current step = first non-done');
  assert.equal(s.completed, 1); pass('completed count');
  assert.equal(deriveProductionStatus([]).overall, 'pending'); pass('empty milestones → pending');
  assert.equal(deriveProductionStatus([{ step_key: 'x', name: 'X', status: 'overdue', sequence_number: 1 }] as never).overall, 'overdue'); pass('any overdue → overdue');
  assert.equal(deriveProductionStatus([{ step_key: 'x', name: 'X', status: 'done', sequence_number: 1 }] as never).overall, 'done'); pass('all done → done');

  // ---- 角色能力 ----
  const proc = resolveCapabilities(['procurement']);
  assert.ok(proc.view && proc.supplierGrouping && proc.executionDetail && proc.procurementCost && proc.productionReadiness); pass('procurement: full');
  assert.equal(proc.orderFinancials, false); pass('procurement: no order financials');

  const merch = resolveCapabilities(['merchandiser']);
  assert.ok(merch.view && merch.supplierGrouping && merch.executionDetail); pass('merchandiser: sees grouping+execution');
  assert.equal(merch.procurementCost, false); pass('merchandiser: no procurement cost');

  const sales = resolveCapabilities(['sales']);
  assert.equal(sales.view, true); pass('sales: can view');
  assert.equal(sales.supplierGrouping, false); pass('sales: NO supplier grouping');
  assert.equal(sales.executionDetail, false); pass('sales: NO execution detail');
  assert.equal(sales.orderFinancials, true); pass('sales: sees order financials');

  const fin = resolveCapabilities(['finance']);
  assert.equal(fin.view, true); pass('finance: can view');
  assert.equal(fin.supplierGrouping, false); pass('finance: NO supplier grouping');
  assert.equal(fin.executionDetail, false); pass('finance: NO execution detail');
  assert.equal(fin.procurementCost, false); pass('finance: NO procurement cost');
  assert.equal(fin.orderFinancials, true); pass('finance: sees order financials');

  const prod = resolveCapabilities(['production']);
  assert.ok(prod.view && prod.productionReadiness); pass('production: view + readiness');
  assert.equal(prod.supplierGrouping, false); pass('production: NO supplier grouping');
  assert.equal(prod.procurementCost, false); pass('production: NO cost');
  assert.equal(prod.orderFinancials, false); pass('production: NO order financials');

  assert.ok(Object.values(resolveCapabilities(['admin'])).every(Boolean)); pass('admin: all caps');
  assert.equal(resolveCapabilities(['quality']).view, false); pass('quality: denied');
  assert.equal(resolveCapabilities(['logistics']).view, false); pass('logistics: denied');

  // ---- 视图按能力裁剪 + 零写（procurement）----
  let mock = makeMock(FIXTURES);
  const vProc = await buildProcurementView(mock.client, 'o1', proc, NOW);
  assert.ok(vProc); pass('view built (procurement)');
  assert.equal(vProc!.derived, true); pass('view.derived=true');
  assert.equal(vProc!.group_by_supplier?.length, 2); pass('procurement: 2 supplier groups');
  assert.equal(vProc!.execution_detail?.length, 2); pass('procurement: 2 execution lines');
  assert.equal(vProc!.group_by_material.length, 2); pass('procurement: 2 material groups');
  assert.equal(vProc!.group_by_material.find((g) => g.material_name === '棉布')?.amount, 10000); pass('procurement: material amount 500×20');
  assert.equal(vProc!.order.total_amount, undefined); pass('procurement: order financials hidden');
  assert.equal(mock.didWrite(), false); pass('procurement view: ZERO db writes');

  // ---- sales：无供应商分组/执行/成本，但有订单金额 ----
  mock = makeMock(FIXTURES);
  const vSales = await buildProcurementView(mock.client, 'o1', sales, NOW);
  assert.equal(vSales!.group_by_supplier, undefined); pass('sales: no supplier grouping in view');
  assert.equal(vSales!.execution_detail, undefined); pass('sales: no execution detail in view');
  assert.equal(vSales!.group_by_material[0].amount, undefined); pass('sales: material cost hidden');
  assert.equal(vSales!.order.total_amount, 12000); pass('sales: order financials shown');
  assert.equal(mock.didWrite(), false); pass('sales view: ZERO db writes');

  // ---- finance：无采购执行细节 ----
  mock = makeMock(FIXTURES);
  const vFin = await buildProcurementView(mock.client, 'o1', fin, NOW);
  assert.equal(vFin!.group_by_supplier, undefined); pass('finance: no supplier grouping');
  assert.equal(vFin!.execution_detail, undefined); pass('finance: no execution detail');
  assert.equal(vFin!.order.total_amount, 12000); pass('finance: order amount shown');
  assert.equal(mock.didWrite(), false); pass('finance view: ZERO db writes');

  // ---- production：物料 readiness + 状态，无供应商/成本/订单金额 ----
  mock = makeMock(FIXTURES);
  const vProd = await buildProcurementView(mock.client, 'o1', prod, NOW);
  assert.ok(vProd!.material_readiness); pass('production: material_readiness present');
  assert.equal(vProd!.material_readiness?.total_materials, 2); pass('production: 2 materials');
  assert.equal(vProd!.group_by_supplier, undefined); pass('production: no supplier grouping');
  assert.equal(vProd!.order.total_amount, undefined); pass('production: order financials hidden');
  assert.equal(mock.didWrite(), false); pass('production view: ZERO db writes');

  // ---- not found ----
  mock = makeMock({ orders: [] });
  assert.equal(await buildProcurementView(mock.client, 'nope', proc, NOW), null); pass('missing order → null');

  // ---- reorder payload（零写）----
  mock = makeMock(FIXTURES);
  const payload = await buildReorderPayload(mock.client, 'o1');
  assert.ok(payload); pass('reorder payload built');
  assert.equal(payload!.derived, true); pass('reorder.derived=true');
  assert.equal(payload!.order_type, 'repeat'); pass('reorder type repeat');
  assert.equal(payload!.line_items.length, 1); pass('reorder 1 line');
  assert.equal(payload!.total_qty, 30); pass('reorder total qty 30');
  assert.equal(mock.didWrite(), false); pass('reorder: ZERO db writes');

  console.log(`\n${passed} passed`);
  console.log('ALL TESTS PASSED');
}

main().catch((e) => {
  console.error('\nTEST FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
