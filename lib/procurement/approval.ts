/**
 * 采购单审批 — 风险闸（纯逻辑，P2a）
 *
 * 卡风险不走流程：只有命中风险触发的采购单才需审批;标准单快路径零审批。
 * 阈值可调常量。采购经理审"买得对"、财务审"付得起/账期"。
 *
 * ⚠️ 账期规则(待用户最终确认)：采购单开给原辅料供应商 → 供应商账期 < 60 天 = 非标 → 财务审。
 *    "工厂账期 < 45 天" 属未来生产/CMT 付款审批，不在采购单(P2a)范围。
 */

export const PROC_APPROVAL_THRESHOLDS = {
  LARGE_AMOUNT: 50_000, // 总额 ≥ 5万 → 审批
  PRICE_VARIANCE_PCT: 5, // |unit_price − price_baseline|/baseline > 5% → 审批
  SUPPLIER_STANDARD_NET_DAYS: 60, // 供应商账期 < 60 天 → 审批（可调）
};

export type ApprovalScope = 'procurement' | 'finance';

export interface ProcApprovalInput {
  totalAmount: number;
  lines: Array<{ unit_price?: number | null; price_baseline?: number | null }>;
  supplierNetDays?: number | null;
  isNewSupplier: boolean;
  orderBudget?: number | null; // 未知则传 null（跳过超预算）
}

export interface ProcApprovalResult {
  needsApproval: boolean;
  reasons: string[]; // large_amount / price_variance / new_supplier / over_budget / non_standard_terms
  requiredBy: ApprovalScope[];
}

export function evaluateProcurementApproval(input: ProcApprovalInput): ProcApprovalResult {
  const T = PROC_APPROVAL_THRESHOLDS;
  const reasons: string[] = [];
  const req = new Set<ApprovalScope>();
  const total = input.totalAmount ?? 0;

  if (total >= T.LARGE_AMOUNT) { reasons.push('large_amount'); req.add('procurement'); req.add('finance'); }

  const hasVariance = (input.lines || []).some((l) => {
    const b = l.price_baseline; const u = l.unit_price;
    return b != null && b > 0 && u != null && (Math.abs(u - b) / b) * 100 > T.PRICE_VARIANCE_PCT;
  });
  if (hasVariance) { reasons.push('price_variance'); req.add('procurement'); req.add('finance'); }

  if (input.isNewSupplier) { reasons.push('new_supplier'); req.add('procurement'); }

  if (input.orderBudget != null && input.orderBudget > 0 && total > input.orderBudget) {
    reasons.push('over_budget'); req.add('procurement'); req.add('finance');
  }

  if (input.supplierNetDays != null && input.supplierNetDays < T.SUPPLIER_STANDARD_NET_DAYS) {
    reasons.push('non_standard_terms'); req.add('finance');
  }

  return { needsApproval: reasons.length > 0, reasons, requiredBy: [...req] };
}

/** P2a 单签：finance 覆盖 procurement（钱是更高的门）。返回该单需要的"最高"审批角色。 */
export function topRequiredScope(requiredBy: ApprovalScope[]): ApprovalScope | null {
  if (requiredBy.includes('finance')) return 'finance';
  if (requiredBy.includes('procurement')) return 'procurement';
  return null;
}

// ============================================================
// 预算闸（2026-07-05 用户拍板）：结合报价基线预算单，超预算 → 拦下需财务审批。
// 口径「整单总额 + 单料双查」：
//   ① 整单:已下单累计 + 本单 > 整单预算总额 → 超
//   ② 单料:某料 已下单累计 + 本单 > 该料预算 → 超(能精准抓「同一个料重复下单」的付重)
// 累计口径是关键 —— 单看本单价内的重复下单每单都合规,却把总额顶穿,正是付重漏洞所在。
// 无冻结预算(order_cost_baseline 缺)→ 跳过,不拦(优雅降级)。
// ============================================================

/** 预算比对容差:单件用量是估算(取该料最大单耗×件数),给 0.5% 防浮点/取整误报;真超仍拦。 */
export const BUDGET_OVER_TOLERANCE_PCT = 0.5;

export interface BudgetGateInput {
  totalBudget: number | null;   // 整单预算总额(跨该单所有 order_id 合计);null=无预算→不判
  committedTotal: number;       // 已下单累计(placed 及之后,不含本单)
  thisPoTotal: number;          // 本单总额
  byMaterial: Array<{ name: string; budget: number | null; committed: number; thisPo: number }>;
}

export interface BudgetGateResult {
  over: boolean;
  overTotal: boolean;
  overMaterials: string[];
  reasons: string[];            // over_budget_total / over_budget_material
}

const overWithTol = (actual: number, budget: number) => actual > budget * (1 + BUDGET_OVER_TOLERANCE_PCT / 100);

export function evaluateBudgetGate(i: BudgetGateInput): BudgetGateResult {
  const reasons: string[] = [];
  const overTotal =
    i.totalBudget != null && i.totalBudget > 0 && overWithTol(i.committedTotal + i.thisPoTotal, i.totalBudget);
  if (overTotal) reasons.push('over_budget_total');

  const overMaterials: string[] = [];
  for (const m of i.byMaterial) {
    if (m.budget != null && m.budget > 0 && overWithTol(m.committed + m.thisPo, m.budget)) {
      overMaterials.push(m.name);
    }
  }
  if (overMaterials.length > 0) reasons.push('over_budget_material');

  return { over: reasons.length > 0, overTotal, overMaterials, reasons };
}

/** 审批原因码 → 中文(通知/详情页可读;含预算闸新码)。 */
export const APPROVAL_REASON_CN: Record<string, string> = {
  large_amount: '大额采购',
  price_variance: '采购价偏离基线',
  new_supplier: '新供应商',
  over_budget: '超预算',
  over_budget_total: '整单超预算',
  over_budget_material: '单料超预算(疑重复下单)',
  non_standard_terms: '非标账期',
};

export function reasonsCn(reasons: string[]): string {
  return (reasons || []).map((r) => APPROVAL_REASON_CN[r] || r).join('、');
}
