import assert from 'node:assert/strict';
import { collectBudgetUnitPriceMismatches, deriveBudgetUnitPriceView, normalizeBudgetUnitPrice } from '../lib/domain/budget-unit-price';
import { saveBomBudgetUnitPriceWithClient } from '../app/actions/procurement-items';

type MockRow = { id: string; order_id: string; budget_unit_price: number | null };
type MockProfile = { role: string; roles: string[] };
type QueryResult<T> = { data: T; error: null };
type MockActionRow = { id: string; budget_unit_price: number | null };
type MockFilterValue = string | string[];
type MockPayload = { budget_unit_price?: number | null };

interface MockQueryBuilder {
  select(columns: string): MockQueryBuilder;
  update(payload: MockPayload): MockQueryBuilder;
  eq(column: string, value: MockFilterValue): MockQueryBuilder;
  in(column: string, value: string[]): MockQueryBuilder;
  order(column: string): MockQueryBuilder;
  single(): Promise<QueryResult<MockProfile | null>>;
  maybeSingle(): Promise<QueryResult<MockProfile | null>>;
  then<TResult1 = QueryResult<MockActionRow[] | MockProfile | null>, TResult2 = never>(
    onFulfilled?: ((value: QueryResult<MockActionRow[] | MockProfile | null>) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2>;
}

type MockSupabaseClient = {
  auth: { getUser: () => Promise<{ data: { user: { id: string } | null }; error: null }> };
  from: (table: string) => MockQueryBuilder;
};
type BudgetHelperClient = Parameters<typeof saveBomBudgetUnitPriceWithClient>[0];

type MockState = {
  rows: MockRow[];
  writes: Array<{ id: string; value: number | null }>;
};

function createMockClient(rows: MockRow[], role: string = 'procurement'): { client: MockSupabaseClient; state: MockState } {
  const state: MockState = {
    rows: rows.map((row) => ({ ...row })),
    writes: [],
  };
  const auth = { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null as const }) };

  const createBuilder = (table: string): MockQueryBuilder => {
    let op: 'select' | 'update' | 'update-select' = 'select';
    const filters: Record<string, MockFilterValue> = {};
    let payload: MockPayload = {};

    const run = async (): Promise<QueryResult<MockActionRow[] | MockProfile | null>> => {
      if (table === 'profiles') {
        return { data: { role, roles: [role] }, error: null };
      }
      if (table !== 'materials_bom') {
        return { data: [], error: null };
      }
      if (op === 'update-select') {
        const id = String(filters.id ?? '');
        const orderId = String(filters.order_id ?? '');
        const row = state.rows.find((r) => r.id === id && r.order_id === orderId);
        if (!row) return { data: [], error: null };
        if (typeof payload.budget_unit_price !== 'undefined') {
          row.budget_unit_price = payload.budget_unit_price;
          state.writes.push({ id: row.id, value: row.budget_unit_price });
        }
        return { data: [{ id: row.id, budget_unit_price: row.budget_unit_price }], error: null };
      }
      if (op === 'select') {
        const orderId = String(filters.order_id ?? '');
        const ids = filters.id;
        const selected = state.rows
          .filter((r) => r.order_id === orderId && (Array.isArray(ids) ? ids.includes(r.id) : true))
          .map((r) => ({ id: r.id, budget_unit_price: r.budget_unit_price }));
        return { data: selected, error: null };
      }
      return { data: [], error: null };
    };

    return {
      select(columns: string) {
        void columns;
        if (op === 'update') op = 'update-select';
        return this;
      },
      update(nextPayload: MockPayload) {
        op = 'update';
        payload = nextPayload;
        return this;
      },
      eq(column: string, value: MockFilterValue) {
        filters[column] = value;
        return this;
      },
      in(column: string, value: string[]) {
        filters[column] = value;
        return this;
      },
      order(column: string) {
        void column;
        return this;
      },
      single: async () => run() as Promise<QueryResult<MockProfile | null>>,
      maybeSingle: async () => run() as Promise<QueryResult<MockProfile | null>>,
      then<TResult1 = QueryResult<MockActionRow[] | MockProfile | null>, TResult2 = never>(
        onFulfilled?: ((value: QueryResult<MockActionRow[] | MockProfile | null>) => TResult1 | PromiseLike<TResult1>) | null,
        onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) {
        return Promise.resolve(run()).then(onFulfilled, onRejected);
      },
    };
  };

  const client: MockSupabaseClient = {
    auth,
    from(table: string) {
      return createBuilder(table);
    },
  };

  return { client, state };
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
  const ok = await saveBomBudgetUnitPriceWithClient(okMock.client as BudgetHelperClient, 'order-1', { 'bom-1': 12.5, 'bom-2': 0 }, { skipPostWriteHooks: true });
  assert.equal((ok as { ok?: boolean }).ok, true);
  assert.equal((ok as { saved?: number }).saved, 2);
  assert.equal(okMock.state.rows.find((r) => r.id === 'bom-1')?.budget_unit_price, 12.5);
  assert.equal(okMock.state.rows.find((r) => r.id === 'bom-2')?.budget_unit_price, 0);

  // zero-row update fails
  const missMock = createMockClient([{ id: 'bom-1', order_id: 'order-1', budget_unit_price: null }]);
  const miss = await saveBomBudgetUnitPriceWithClient(missMock.client as BudgetHelperClient, 'order-1', { 'missing-row': 9 }, { skipPostWriteHooks: true });
  assert.match(String((miss as { error?: string }).error || ''), /未返回唯一更新行|写入失败/);

  // unauthorized write rejected
  const noAuthMock = createMockClient([{ id: 'bom-1', order_id: 'order-1', budget_unit_price: null }], 'logistics');
  const noAuth = await saveBomBudgetUnitPriceWithClient(noAuthMock.client as BudgetHelperClient, 'order-1', { 'bom-1': 9 }, { skipPostWriteHooks: true });
  assert.match(String((noAuth as { error?: string }).error || ''), /仅业务\/理单\/采购\/管理员可填预算单价/);

  const negativeMock = createMockClient([{ id: 'bom-1', order_id: 'order-1', budget_unit_price: null }]);
  const negative = await saveBomBudgetUnitPriceWithClient(negativeMock.client as BudgetHelperClient, 'order-1', { 'bom-1': -1 }, { skipPostWriteHooks: true });
  assert.match(String((negative as { error?: string }).error || ''), /预算单价不能为负数/);

  console.log('budget unit price contract: assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
