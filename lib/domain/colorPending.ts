/**
 * 「颜色待定」— 建单/确认时颜色尚未确定,允许先推进、颜色定了再到订单明细补齐并核对。
 * 复用 orders.special_tags text[] 存标签(无迁移)。
 * PO确认(po_confirmed)的「颜色核对一致」(color_verified)在待定时免校验,不卡节点;
 * 订单顶部常驻提醒,颜色确定后取消标签即可。2026-07-11 用户拍板。
 */

export const COLOR_PENDING_TAG = '颜色待定';

export function isColorPending(order: { special_tags?: string[] | null } | null | undefined): boolean {
  const tags = Array.isArray(order?.special_tags) ? order!.special_tags! : [];
  return tags.includes(COLOR_PENDING_TAG);
}
