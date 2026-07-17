import assert from 'node:assert/strict';
import { collectBudgetUnitPriceMismatches, deriveBudgetUnitPriceView, normalizeBudgetUnitPrice } from '../lib/domain/budget-unit-price';
import { saveBomBudgetUnitPriceWithClient } from '../app/actions/procurement-items';

type MockRow = { id: string; order_id: string; budget_unit_price: number | null };

function createMockClient(rows: MockRow[], role: string = 'procurement') {
  const state = {
    rows: rows.map((row) => ({ ...row })),
    writes: [] as Array<{ id: string; value: number | null }>,
  };
  const auth = { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) };
  const from = (table: string) => {
    const builder: any = {
      _table: table,
      _op: 'select',
      _filters: {} as Record<string, any>,
      _payload: null as Record<string, any> | null,
      select(_cols: string) {
        if (builder._op === 'update') builder._op = 'update-select';
        return builder;
      },
      update(payload: Record<string, any>) {
        builder._op = 'update';
        builder._payload = payload;
        return builder;
      },
      eq(col: string, value: any) { builder._filters[col] = value; return builder; },
      in(col: string, value: any[]) { builder._filters[col] = value; return builder; },
      order() { return builder; },
      single: async () => {
        if (table === 'profiles') {
          return { data: { role, roles: [role] }, error: null };
        }
        return { data: null, error: null };
      },
      maybeSingle: async () => {
        if (table === 'profiles') {
          return { data: { role, roles: [role] }, error: null };
        }
        return { data: null, error: null };
      },
      then(onFulfilled: (value: any) => any, onRejected?: (reason: any) => any) {
        return Promise.resolve(run()).then(onFulfilled, onRejected);
      },
    };

    const run = async () => {
      if (table === 'profiles') {
        return { data: { role, roles: [role] }, error: null };
      }
      if (table !== 'materials_bom') {
        return { data: [], error: null };
      }
      if (builder._op === 'update-select') {
        const id = builder._filters.id;
        const orderId = builder._filters.order_id;
        const row = state.rows.find((r) => r.id === id && r.order_id === orderId);
        if (!row) return { data: [], error: null };
        if (typeof builder._payload?.budget_unit_price !== 'undefined') {
          row.budget_unit_price = builder._payload.budget_unit_price;
          state.writes.push({ id: row.id, value: row.budget_unit_price });
        }
        return { data: [{ id: row.id, budget_unit_price: row.budget_unit_price }], error: null };
      }
      if (builder._op === 'select') {
        const orderId = builder._filters.order_id;
        const ids = builder._filters.id;
        const selected = state.rows
          .filter((r) => r.order_id === orderId && (Array.isArray(ids) ? ids.includes(r.id) : true))
          .map((r) => ({ id: r.id, budget_unit_price: r.budget_unit_price }));
        return { data: selected, error: null };
      }
      return { data: [], error: null };
    };

    return builder;
  };
  return { client: { auth, from }, state };
}

async function main() {
  // normalization
  assert.equal(normalizeBudgetUnitPrice(null), '');
  assert.equal(normalizeBudgetUnitPrice(3), '3');
  assert.equal(normalizeBudgetUnitPrice(3.0), '3');
  assert.equal(normalizeBudgetUnitPrice(3.0000), '3');
  assert.equal(normalizeBudgetUnitPrice('3.2500'), '3.25');
  assert.equal(normalizeBudgetUnitPrice('1.234500'), '1.2345');
  assert.equal(normalizeBudgetUnitPrice(-1), '-1');

  // read semantics
  assert.deepEqual(deriveBudgetUnitPriceView(null, 9.25), {
    budgetUnitPrice: null,
    quotationBaselineUnitPrice: 9.25,
    effectiveDisplayUnitPrice: 9.25,
    budgetPriceSource: 'quotation_baseline',
  });
  assert.deepEqual(deriveBudgetUnitPriceView(0, 9.25), {
    budgetUnitPrice: 0,
    quotationBaselineUnitPrice: 9.25,
    effectiveDisplayUnitPrice: 0,
    budgetPriceSource: 'saved_budget',
  });
  assert.deepEqual(collectBudgetUnitPriceMismatches(
    [
      { id: 'a', budget_unit_price: 3 },
      { id: 'b', budgetUnitPrice: 1 },
    ],
    { a: 3.0, b: 0 },
  ), [{ id: 'b', expected: '0', actual: '1' }]);

  // persistence contract success
  const okRows = [
    { id: 'bom-1', order_id: 'order-1', budget_unit_price: null },
    { id: 'bom-2', order_id: 'order-1', budget_unit_price: 4 },
  ];
  const okMock = createMockClient(okRows);
  const ok = await saveBomBudgetUnitPriceWithClient(okMock.client, 'order-1', { 'bom-1': 12.5, 'bom-2': 0 }, { skipPostWriteHooks: true });
  assert.equal((ok as any).ok, true);
  assert.equal((ok as any).saved, 2);
  assert.equal(okMock.state.rows.find((r) => r.id === 'bom-1')?.budget_unit_price, 12.5);
  assert.equal(okMock.state.rows.find((r) => r.id === 'bom-2')?.budget_unit_price, 0);

  // zero-row update fails
  const missMock = createMockClient([{ id: 'bom-1', order_id: 'order-1', budget_unit_price: null }]);
  const miss = await saveBomBudgetUnitPriceWithClient(missMock.client, 'order-1', { 'missing-row': 9 }, { skipPostWriteHooks: true });
  assert.match(String((miss as any).error || ''), /未返回唯一更新行|写入失败/);

  // unauthorized write rejected
  const noAuthMock = createMockClient([{ id: 'bom-1', order_id: 'order-1', budget_unit_price: null }], 'logistics');
  const noAuth = await saveBomBudgetUnitPriceWithClient(noAuthMock.client, 'order-1', { 'bom-1': 9 }, { skipPostWriteHooks: true });
  assert.match(String((noAuth as any).error || ''), /仅业务\/理单\/采购\/管理员可填预算单价/);

  const negativeMock = createMockClient([{ id: 'bom-1', order_id: 'order-1', budget_unit_price: null }]);
  const negative = await saveBomBudgetUnitPriceWithClient(negativeMock.client, 'order-1', { 'bom-1': -1 }, { skipPostWriteHooks: true });
  assert.match(String((negative as any).error || ''), /预算单价不能为负数/);

  console.log('budget unit price contract: assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
