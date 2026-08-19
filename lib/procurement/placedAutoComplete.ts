/**
 * 「采购下单」节点自动完成的判据(纯逻辑,无 IO)。
 *
 * ⚠️ 必须放在**纯模块**里,不能放 app/actions/procurement-items.ts ——
 *    那是 'use server' 文件,只允许导出 async 函数;导出常量/同步函数会过 build
 *    但运行时报「A "use server" file can only export async functions」,把整条
 *    action chunk 打挂(见 scripts/pre-deploy-check.ts 的静态闸)。
 */
/** 「已下单及以后」的状态集合(采购项 status 与执行行 line_status 共用同一档口径)。 */
const PLACED_OR_BEYOND = ['ordered', 'partially_received', 'completed', 'closed'];

/**
 * 「采购下单」节点是否该自动完成 —— 纯判据,抽出来可单测(见 tests/procurement-placed-autocomplete.test.ts)。
 *
 * 两种单形态各有各的证据来源:
 * · 自产单:原辅料归并成 procurement_items → 全部已下单才算完成。
 * · 经销单(trade):买成品,**不建 procurement_items**,大货采购直接物化成
 *   procurement_line_items(procurement_item_id=null, category='成品大货',见 trade-purchase.ts)。
 *   2026-08-19 修:此前这里只看 procurement_items,经销单恒为 0 行 → 直接 return false,
 *   于是无论下达多少次采购单,「供应商下单」节点永远停在 pending;而采购角色进订单详情又会被
 *   isProcurementOnly 改道核料页 —— **没有任何地方能完成这个节点**
 *   (实测 1022988:procurement_items 0 行 / procurement_line_items 11 行全已挂 PO)。
 */
export function shouldCompleteProcurementPlaced(
  items: Array<{ status: string | null }> | null | undefined,
  lines: Array<{ line_status: string | null; purchase_order_id: string | null }> | null | undefined,
): boolean {
  if (items && items.length > 0) {
    return items.every((i) => PLACED_OR_BEYOND.includes(String(i.status)));
  }
  // 经销单:全部执行行都归到了采购单 + 状态已到 ordered 及以后
  // (草稿/pending_order 是「建了单还没下达」,不能算完成)
  if (!lines || lines.length === 0) return false;
  return lines.every((l) => !!l.purchase_order_id && PLACED_OR_BEYOND.includes(String(l.line_status)));
}
