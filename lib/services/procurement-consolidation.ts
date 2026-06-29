/**
 * Procurement Item 核料归并 —— 纯函数(归并键 + 建议采购量),无 DB,可单测(仿 lib/services/mrp.ts)。
 * P1′:同订单内按 物料身份 + 颜色 + 单位 归并;采购永不手算,系统出 suggested。
 */

function num(v: any): number | null {
  if (v === '' || v == null || isNaN(Number(v))) return null;
  return Number(v);
}

export interface IdentityInput {
  material_master_id?: string | null;
  material_name?: string | null;
  specification?: string | null;
  category?: string | null;
  color?: string | null;
  unit?: string | null;
}

/**
 * 归并键(order 内唯一):material_master_id 优先;无 master 用 名+规格+类别。再 + 颜色 + 单位。
 * 同 key → 同一采购核料项。
 */
export function consolidationKey(input: IdentityInput): string {
  const norm = (v: any) => (v ?? '').toString().trim().toLowerCase();
  const identity = input.material_master_id
    ? `m:${input.material_master_id}`
    : `n:${norm(input.material_name)}|${norm(input.specification)}|${norm(input.category)}`;
  return `${identity}¦c:${norm(input.color)}¦u:${norm(input.unit)}`;
}

export interface SuggestInput {
  total_required_qty?: number | null;   // 净需求(系统,开发单耗算)
  development_consumption?: number | null;
  production_consumption?: number | null;
  procurement_loss_pct?: number | null;
  safety_stock_qty?: number | null;
  moq?: number | null;
}

/**
 * 建议采购量 = 净需求 × (大货单耗 / 开发单耗) × (1 + 采购损耗%) + 安全库存,再按 MOQ 向上取整。
 * 大货/开发 比:两者都有且 dev>0 才放大,否则比 = 1(无大货单耗时不放大)。
 */
export function computeSuggestedPurchaseQty(input: SuggestInput): number | null {
  const net = num(input.total_required_qty);
  if (net == null) return null;
  const dev = num(input.development_consumption);
  const prod = num(input.production_consumption);
  const ratio = (dev && dev > 0 && prod && prod > 0) ? prod / dev : 1;
  const loss = num(input.procurement_loss_pct) ?? 0;
  const safety = num(input.safety_stock_qty) ?? 0;

  let qty = net * ratio * (1 + loss / 100) + safety;
  const moq = num(input.moq);
  if (moq && moq > 0) {
    qty = Math.ceil(qty / moq) * moq;   // 向上取到 MOQ 整数倍(保证 ≥ MOQ 且对齐)
  } else {
    qty = Math.ceil(qty);
  }
  return qty;
}
