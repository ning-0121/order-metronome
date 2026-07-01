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
