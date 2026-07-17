export type BudgetUnitPriceRow = {
  id: string;
  budget_unit_price?: number | null;
};

export function normalizeBudgetUnitPrice(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  const num = Number(value);
  return Number.isFinite(num) ? String(num) : '';
}

export function collectBudgetUnitPriceMismatches(
  rows: BudgetUnitPriceRow[],
  expected: Record<string, number | null>,
) {
  const mismatches: Array<{ id: string; expected: string; actual: string }> = [];
  const byId = new Map((rows || []).map((row) => [row.id, row]));
  for (const [id, rawExpected] of Object.entries(expected || {})) {
    const row = byId.get(id);
    const expectedValue = normalizeBudgetUnitPrice(rawExpected);
    const actualValue = row ? normalizeBudgetUnitPrice(row.budget_unit_price) : '';
    if (expectedValue !== actualValue) {
      mismatches.push({ id, expected: expectedValue, actual: actualValue });
    }
  }
  return mismatches;
}
