/**
 * 统一评分申诉的纯逻辑(2026-07-25 CEO 批的评分制度 Q3)。便于单测,server/client 通用。
 */

export type AppealType = 'po_overdue' | 'node_overdue' | 'quality';
export type Decision = 'approved' | 'rejected' | null | undefined;

/** 申诉的一审角色(域路由):PO→业务经理;生产/QC→生产主管;采购→采购经理;其余→业务经理。 */
export function routeReviewerRole(appealType: AppealType, ownerRole?: string | null): string {
  if (appealType === 'po_overdue') return 'order_manager';
  const r = ownerRole || '';
  if (['production', 'qc', 'quality', 'production_manager'].includes(r)) return 'production_manager';
  if (['procurement', 'procurement_manager'].includes(r)) return 'procurement_manager';
  return 'order_manager';
}

/**
 * 汇总裁决:老板 override 优先;任一驳回即驳回;
 * PO逾期需【域经理 + 财务】双批,其余只需域经理批;否则 pending。
 */
export function resolveAppeal(a: {
  appeal_type: string; reviewer_decision?: Decision; finance_decision?: Decision; admin_override?: Decision;
}): 'pending' | 'approved' | 'rejected' {
  if (a.admin_override === 'approved') return 'approved';
  if (a.admin_override === 'rejected') return 'rejected';
  if (a.reviewer_decision === 'rejected' || a.finance_decision === 'rejected') return 'rejected';
  if (a.appeal_type === 'po_overdue') {
    return a.reviewer_decision === 'approved' && a.finance_decision === 'approved' ? 'approved' : 'pending';
  }
  return a.reviewer_decision === 'approved' ? 'approved' : 'pending';
}

/** 申诉时限:节点逾期/完成后 N 天内(无参照日则不卡)。 */
export const APPEAL_WINDOW_DAYS = 7;
export function withinAppealWindow(refDateIso: string | null | undefined, nowMs: number): boolean {
  if (!refDateIso) return true;
  const ref = new Date(refDateIso).getTime();
  if (isNaN(ref)) return true;
  return nowMs <= ref + APPEAL_WINDOW_DAYS * 86400000;
}
