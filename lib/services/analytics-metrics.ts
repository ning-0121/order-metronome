import { sumPhysicalPieceQty } from '@/lib/domain/line-item-quantity';

export interface AnalyticsOrderQuantityLike {
  id?: string;
  quantity?: number | null;
  order_purpose?: string | null;
  lifecycle_status?: string | null;
}

const EXCLUDED_STATUSES = new Set(['cancelled', '已取消', 'closed', '已关闭', 'archived', '已归档']);

function normalize(value: string | null | undefined): string {
  return String(value || '').trim().toLowerCase();
}

// 统计口径【单一真相源】(2026-07-27 CEO):含 生产/贸易/经销(都是真实业务),只排 取消/样品/询价。
//
// 2026-07-30:这里原本还有第二个判定 isEffectiveOrderQuantitySource(额外排 trade),总览走它、
// 客户页走下面这个 → 同一个「有效件数」两套口径,总览把贸易单整个漏掉:
// 总览 2,295,695(162 单) vs 客户页加总 2,620,821(183 单),差额 325,126 恰为 21 张未取消贸易单。
// 已删掉那个分叉,全站只留这一个判定,避免再次各算各的。
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
    const sum = sumPhysicalPieceQty(lines);   // 统一入口(禁止裸算套/件换算,2026-08-12)
    // 明细行在、但 qty_pcs 全空/为 0(只建了行没录数量)→ 回退 quantity。
    // 不回退的话整单静默算 0 件:2026-07-30 实测 4 单如此(QM-20260727-005 等,合计 28,964 件凭空消失)。
    if (sum > 0) return sum;
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
  const effectiveOrders = (orders || []).filter(isStatCountableOrder);
  return {
    orderCount: effectiveOrders.length,
    totalQuantity: effectiveOrders.reduce((sum, order) => sum + orderStatPieces(order, order.id ? linesByOrder?.get(order.id) : undefined), 0),
    scopeLabel: '有效订单总件数',
    scopeHint: '口径：含生产/贸易/经销，排除取消/关闭/样品/询价，套装按每套2件(以明细为准)汇总；与客户页一致，与客户年度目标口径不同',
  };
}
