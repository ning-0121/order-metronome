/**
 * 采购成本核算 + 订收差异 —— 纯逻辑（P4 A+C）
 *
 * P4a 成本核算：Σ 采购实际成本(收货优先,无则订购) vs 材料预算 → 差异。
 * P4b-C 订收差异：received ≠ ordered 的超收/短收统计 —— ⚠️ 这是"订了vs收了",
 *       **不是真尾货(收了vs用了)**;真尾货需生产消耗链(未建)。
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface CostLine {
  material_name?: string | null;
  category?: string | null;
  ordered_unit?: string | null;
  ordered_qty?: number | null;
  received_qty?: number | null;
  unit_price?: number | null;
  ordered_amount?: number | null;
}

export interface ProcurementCostSummary {
  actual_cost: number;
  budget_material_cost: number | null;
  variance: number | null; // actual − budget
  variance_pct: number | null;
  line_count: number;
  basis: 'received' | 'ordered' | 'mixed' | 'none';
}

/** 实际采购成本(收货优先:received×unit_price;未收则用订购金额) vs 预算。 */
export function computeProcurementCostSummary(
  lines: CostLine[],
  budgetMaterialCost: number | null,
): ProcurementCostSummary {
  let actual = 0;
  let usedReceived = 0;
  let usedOrdered = 0;
  for (const l of lines) {
    const up = Number(l.unit_price) || 0;
    if (l.received_qty != null) {
      actual += (Number(l.received_qty) || 0) * up;
      usedReceived++;
    } else {
      actual += l.ordered_amount != null ? Number(l.ordered_amount) || 0 : (Number(l.ordered_qty) || 0) * up;
      usedOrdered++;
    }
  }
  actual = round2(actual);
  const budget = budgetMaterialCost;
  const variance = budget != null ? round2(actual - budget) : null;
  const variance_pct = budget != null && budget > 0 ? round2(((actual - budget) / budget) * 100) : null;
  const basis: ProcurementCostSummary['basis'] =
    lines.length === 0 ? 'none' : usedReceived && usedOrdered ? 'mixed' : usedReceived ? 'received' : 'ordered';
  return { actual_cost: actual, budget_material_cost: budget, variance, variance_pct, line_count: lines.length, basis };
}

export interface ReceivingDiffLine {
  material_name: string | null;
  ordered_qty: number;
  received_qty: number;
  diff_qty: number;
  diff_amount: number;
}
export interface ReceivingDiff {
  over: ReceivingDiffLine[]; // 超收 received > ordered
  short: ReceivingDiffLine[]; // 短收 received < ordered
  total_diff_amount: number;
}

/** 订收差异（仅已收行）。⚠️ 非真尾货。 */
export function computeReceivingDiff(lines: CostLine[]): ReceivingDiff {
  const over: ReceivingDiffLine[] = [];
  const short: ReceivingDiffLine[] = [];
  let total = 0;
  for (const l of lines) {
    if (l.received_qty == null) continue; // 未收不算
    const oq = Number(l.ordered_qty) || 0;
    const rq = Number(l.received_qty) || 0;
    const d = rq - oq;
    if (d === 0) continue;
    const amt = round2(d * (Number(l.unit_price) || 0));
    total += amt;
    const rec: ReceivingDiffLine = { material_name: l.material_name ?? null, ordered_qty: oq, received_qty: rq, diff_qty: round2(d), diff_amount: amt };
    (d > 0 ? over : short).push(rec);
  }
  return { over, short, total_diff_amount: round2(total) };
}
