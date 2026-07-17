export type BudgetUnitPriceRow = {
  id: string;
  budget_unit_price?: number | null;
  budgetUnitPrice?: number | null;
};

export type BudgetPriceSource = 'saved_budget' | 'quotation_baseline' | 'empty';

export type BudgetUnitPriceView = {
  budgetUnitPrice: number | null;
  quotationBaselineUnitPrice: number | null;
  effectiveDisplayUnitPrice: number | null;
  budgetPriceSource: BudgetPriceSource;
};

export function normalizeBudgetUnitPrice(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  const num = Number(value);
  return Number.isFinite(num) ? String(num) : '';
}

export function deriveBudgetUnitPriceView(
  budgetUnitPrice: unknown,
  quotationBaselineUnitPrice: unknown,
): BudgetUnitPriceView {
  const saved = budgetUnitPrice === null || budgetUnitPrice === undefined || budgetUnitPrice === ''
    ? null
    : Number(budgetUnitPrice);
  const baseline = quotationBaselineUnitPrice === null || quotationBaselineUnitPrice === undefined || quotationBaselineUnitPrice === ''
    ? null
    : Number(quotationBaselineUnitPrice);
  const safeSaved = Number.isFinite(saved as number) ? Number(saved) : null;
  const safeBaseline = Number.isFinite(baseline as number) ? Number(baseline) : null;
  const source: BudgetPriceSource = safeSaved != null
    ? 'saved_budget'
    : safeBaseline != null
      ? 'quotation_baseline'
      : 'empty';
  return {
    budgetUnitPrice: safeSaved,
    quotationBaselineUnitPrice: safeBaseline,
    effectiveDisplayUnitPrice: safeSaved ?? safeBaseline,
    budgetPriceSource: source,
  };
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
    const actualValue = row ? normalizeBudgetUnitPrice(row.budget_unit_price ?? row.budgetUnitPrice ?? null) : '';
    if (expectedValue !== actualValue) {
      mismatches.push({ id, expected: expectedValue, actual: actualValue });
    }
  }
  return mismatches;
}
