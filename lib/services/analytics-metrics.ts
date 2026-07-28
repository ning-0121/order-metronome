export interface AnalyticsOrderQuantityLike {
  id?: string;
  quantity?: number | null;
  order_purpose?: string | null;
  lifecycle_status?: string | null;
}

const EXCLUDED_PURPOSES = new Set(['trade', 'sample', 'inquiry']);
const EXCLUDED_STATUSES = new Set(['cancelled', '已取消', 'closed', '已关闭', 'archived', '已归档']);

function normalize(value: string | null | undefined): string {
  return String(value || '').trim().toLowerCase();
}

export function isEffectiveOrderQuantitySource(order: AnalyticsOrderQuantityLike): boolean {
  const purpose = normalize(order.order_purpose);
  if (purpose && EXCLUDED_PURPOSES.has(purpose)) return false;
  const status = String(order.lifecycle_status || '').trim();
  if (status && EXCLUDED_STATUSES.has(status)) return false;
  return true;
}

// 客户/员工统计口径(2026-07-27 CEO):含 生产/贸易/经销(都是该客户/员工真实业务),只排 取消/样品/询价。
const STAT_EXCLUDED_PURPOSES = new Set(['sample', 'inquiry']);
export function isStatCountableOrder(order: AnalyticsOrderQuantityLike): boolean {
  const purpose = normalize(order.order_purpose);
  if (purpose && STAT_EXCLUDED_PURPOSES.has(purpose)) return false;
  const status = String(order.lifecycle_status || '').trim();
  if (status && EXCLUDED_STATUSES.has(status)) return false;
  return true;
}

/**
 * 套→件(仅统计口径,不影响报价/采购/生产 —— 那些仍按套)。一个订单的统计件数:
 * 优先按逐款明细 Σ(qty_pcs × set_multiplier)——2-pack 行 ×2、单件行 ×1,正确处理"一套=两件";
 * 无明细则回退 orders.quantity。(orders.quantity 对混合套装单不可靠,故优先明细。)
 */
export function orderStatPieces(order: { quantity?: number | null }, lines?: Array<{ qty_pcs?: number | null; set_multiplier?: number | null }>): number {
  if (lines && lines.length > 0) {
    return lines.reduce((s, l) => s + (Number(l.qty_pcs) || 0) * (Number(l.set_multiplier) || 1), 0);
  }
  return Number(order.quantity) || 0;
}

export function summarizeEffectiveOrderQuantity(
  orders: AnalyticsOrderQuantityLike[],
  linesByOrder?: Map<string, Array<{ qty_pcs?: number | null; set_multiplier?: number | null }>>,   // 传入则套→件(每单按明细算),不传则按 quantity(向后兼容)
): {
  orderCount: number;
  totalQuantity: number;
  scopeLabel: string;
  scopeHint: string;
} {
  const effectiveOrders = (orders || []).filter(isEffectiveOrderQuantitySource);
  return {
    orderCount: effectiveOrders.length,
    totalQuantity: effectiveOrders.reduce((sum, order) => sum + orderStatPieces(order, order.id ? linesByOrder?.get(order.id) : undefined), 0),
    scopeLabel: '有效订单总件数',
    scopeHint: '口径：排除取消/关闭/贸易/样品订单，套装按每套2件(以明细为准)汇总；与客户年度目标口径不同',
  };
}
