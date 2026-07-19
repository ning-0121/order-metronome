export interface AnalyticsOrderQuantityLike {
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

export function summarizeEffectiveOrderQuantity(orders: AnalyticsOrderQuantityLike[]): {
  orderCount: number;
  totalQuantity: number;
  scopeLabel: string;
  scopeHint: string;
} {
  const effectiveOrders = (orders || []).filter(isEffectiveOrderQuantitySource);
  return {
    orderCount: effectiveOrders.length,
    totalQuantity: effectiveOrders.reduce((sum, order) => sum + (Number(order.quantity) || 0), 0),
    scopeLabel: '有效订单总件数',
    scopeHint: '口径：排除取消/关闭/贸易/样品订单，按有效订单件数汇总；与客户年度目标口径不同',
  };
}
