/**
 * 尺码真相源收口(2026-07-24 根因3)。
 * 采购项的"尺码意图"存 procurement_items.size_qty_override = { [size]: qty };
 * 执行行(procurement_line_items,采购行/导出/收货/财务读的物化真相)从它派生 —— 一处纯函数,别处别再各写各的。
 */

/** size_qty_override({size: qty}) → 执行行分段 [{size, qty}](qty>0 才留;非法输入 → 空数组)。 */
export function overrideToSegments(override: unknown): Array<{ size: string; qty: number }> {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return [];
  return Object.entries(override as Record<string, unknown>)
    .map(([size, qty]) => ({ size: String(size), qty: Number(qty) || 0 }))
    .filter((s) => s.qty > 0);
}

/** 分段总量(= 该采购项按尺码拆分后的总件数)。 */
export function segmentsTotal(segs: Array<{ qty: number }>): number {
  return segs.reduce((s, x) => s + (Number(x.qty) || 0), 0);
}
