/**
 * Procurement Kernel — 纯确定性计算(ADR-005 唯一计算区)
 * 无 DB、无副作用、可单测。消费单一源(demand=MRP · available=inventoryKernel · suppliers=material_supplier),
 * 绝不重算它们。输出:shortageTruth(缺什么)· sourcingTruth(向谁买)· executionTruth(做什么动作)。
 */

const round3 = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;

// ── 1) shortageTruth:net = demand − available(唯一缺口口径)──
export interface ShortageInput {
  material_key: string;
  material_name?: string | null;
  unit?: string | null;
  demand: number;       // 来自 MRP/procurement_items(单一源,不重算)
  available: number;    // 来自 inventoryKernel computeAvailability(单一源,不重算)
}
export interface ShortageRow extends ShortageInput {
  net: number;          // demand − available(可负=盈余)
  toBuy: number;        // max(0, net):真正要买的量
  surplus: number;      // max(0, −net):盈余
  coverage: number;     // 齐料率 min(1, available/demand)
  hasShortage: boolean;
}
export function shortageTruth(items: ShortageInput[]): ShortageRow[] {
  return (items || []).map((it) => {
    const demand = round3(it.demand);
    const available = round3(it.available);
    const net = round3(demand - available);
    const toBuy = round3(Math.max(0, net));
    const surplus = round3(Math.max(0, -net));
    const coverage = demand > 0 ? Math.min(1, round3(available / demand)) : 1;
    return { ...it, demand, available, net, toBuy, surplus, coverage, hasShortage: toBuy > 0 };
  });
}

// ── 2) sourcingTruth:供应商按 价/期/履约 加权打分排序(只建议,不决定)──
export interface SupplierInput {
  supplier_id: string;
  supplier_name?: string | null;
  unit_price?: number | null;
  lead_days?: number | null;
  is_preferred?: boolean;
}
export interface SupplierWeights { price: number; lead: number; reliability: number; }
export const DEFAULT_SUPPLIER_WEIGHTS: SupplierWeights = { price: 0.5, lead: 0.3, reliability: 0.2 };
export interface ScoredSupplier extends SupplierInput {
  priceScore: number; leadScore: number; reliabilityScore: number; score: number; rank: number;
}

/** 集合内归一化(值越小越好 → 分越高)。缺值 → 0 分(该维最差)。全等 → 1。 */
function normInverse(x: number | null | undefined, arr: number[]): number {
  const v = Number(x);
  if (!(v > 0) || arr.length === 0) return 0;
  const min = Math.min(...arr), max = Math.max(...arr);
  if (max === min) return 1;
  return round3((max - v) / (max - min));
}
export function sourcingTruth(
  rows: SupplierInput[],
  opts?: { weights?: SupplierWeights; reliability?: Map<string, number> },
): ScoredSupplier[] {
  const w = opts?.weights ?? DEFAULT_SUPPLIER_WEIGHTS;
  const prices = (rows || []).map((r) => Number(r.unit_price)).filter((v) => v > 0);
  const leads = (rows || []).map((r) => Number(r.lead_days)).filter((v) => v > 0);
  const scored: ScoredSupplier[] = (rows || []).map((r) => {
    const priceScore = normInverse(r.unit_price, prices);
    const leadScore = normInverse(r.lead_days, leads);
    // 履约数据未建(无 supplier_performance)→ 中性 0.5(诚实占位,SC-P3 接真值)
    const reliabilityScore = opts?.reliability?.get(r.supplier_id) ?? 0.5;
    const score = round3(w.price * priceScore + w.lead * leadScore + w.reliability * reliabilityScore);
    return { ...r, priceScore, leadScore, reliabilityScore, score, rank: 0 };
  });
  // 确定性排序:分降序 → 首选优先 → supplier_id 稳定
  scored.sort((a, b) =>
    b.score - a.score
    || (Number(!!b.is_preferred) - Number(!!a.is_preferred))
    || a.supplier_id.localeCompare(b.supplier_id));
  scored.forEach((s, i) => { s.rank = i + 1; });
  return scored;
}

// ── 3) executionTruth:买什么 / 为什么 / 向谁 / 紧急度(不执行)──
export type Urgency = 'urgent' | 'soon' | 'normal';
const urgencyRank = (u: Urgency) => (u === 'urgent' ? 2 : u === 'soon' ? 1 : 0);
export interface ExecStep {
  material_key: string;
  material_name: string | null;
  unit: string | null;
  toBuy: number;
  reason: string;
  supplier: ScoredSupplier | null;  // 排名第一(建议,人可改)
  urgency: Urgency;
}
export function executionTruth(
  shortages: ShortageRow[],
  sourcingByKey: Map<string, ScoredSupplier[]>,
  timingByKey?: Map<string, string>,  // material_key → material_requirements.timing_status
): ExecStep[] {
  const steps = (shortages || []).filter((s) => s.hasShortage).map((s) => {
    const suppliers = sourcingByKey.get(s.material_key) || [];
    const timing = timingByKey?.get(s.material_key);
    const urgency: Urgency = timing === 'late' ? 'urgent' : timing === 'due_soon' ? 'soon' : 'normal';
    return {
      material_key: s.material_key,
      material_name: s.material_name ?? null,
      unit: s.unit ?? null,
      toBuy: s.toBuy,
      reason: `需求 ${s.demand} − 可用 ${s.available} = 缺口 ${s.toBuy}`,
      supplier: suppliers[0] || null,
      urgency,
    } as ExecStep;
  });
  // 紧急优先,其次缺口大者
  return steps.sort((a, b) => urgencyRank(b.urgency) - urgencyRank(a.urgency) || b.toBuy - a.toBuy);
}
