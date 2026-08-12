/**
 * 明细数量语义 —— 唯一入口(2026-08-12 Quantity Semantics Hotfix)。
 *
 * 【为什么必须有这一层】
 * 1022977 事故:采购核料把 `qty_pcs`(**商业数量/套数**)当成物理件数用,少乘一次 set_multiplier;
 * 下游换算引擎又按"套装单"除一次 → 面料基准整整差一倍,直接影响采购金额与实际下料。
 * 同一个坑此前在面料算料上已经踩过一次([[set-order-fabric-per-set]])。
 *
 * 【两层语义,一级业务概念,不许再靠猜】
 *   Commercial Quantity   客户买了多少 —— `order_line_items.qty_pcs`(套装单=套数)
 *   Physical Piece Qty    实际生产多少件单品 —— commercial × set_multiplier
 *
 * 例(1022977):commercial 3600 套 × set_multiplier 2 = physical 7200 件
 *
 * 【全库实测语义(2026-08-12 只读盘点,60 单有效样本)】
 *   `orders.quantity` = **physical pieces**(套装单 10/10 命中 physical,0 命中 commercial)
 *   `orders.quantity_unit`(如 '套')= **该单是不是套装的标记**,不是 quantity 的计量单位。
 *   → 不翻语义、不改存量数据;代码一律用本文件的 helper 表达意图。
 *
 * 【铁律】业务代码**禁止**再写 `qty_pcs * set_multiplier` 或 `qty_pcs / set_multiplier`,
 * 一律走下面四个函数;静态闸 scripts/check-quantity-semantics.mjs 盯防。
 */

export interface LineItemQtyShape {
  qty_pcs?: number | string | null;
  set_multiplier?: number | string | null;
}

/** 件/套倍率:缺失/非法一律按 1(非套装单) */
export function setMultiplierOf(li: LineItemQtyShape | null | undefined): number {
  const m = Number(li?.set_multiplier);
  return Number.isFinite(m) && m > 0 ? m : 1;
}

/** 商业数量:客户买了多少(套装单 = 套数)。用于:报价/客户金额/装箱套数/页面"X套"展示。 */
export function getCommercialQty(li: LineItemQtyShape | null | undefined): number {
  const q = Number(li?.qty_pcs);
  return Number.isFinite(q) && q > 0 ? q : 0;
}

/** 物理件数:实际生产多少件单品。用于:面料/辅料算料、MRP 净需求、生产工作量、采购基准。 */
export function getPhysicalPieceQty(li: LineItemQtyShape | null | undefined): number {
  return getCommercialQty(li) * setMultiplierOf(li);
}

export function sumCommercialQty(items: Array<LineItemQtyShape | null | undefined> | null | undefined): number {
  return (items || []).reduce((s, li) => s + getCommercialQty(li), 0);
}

export function sumPhysicalPieceQty(items: Array<LineItemQtyShape | null | undefined> | null | undefined): number {
  return (items || []).reduce((s, li) => s + getPhysicalPieceQty(li), 0);
}

/**
 * 按 款 / 款×色 汇总**物理件数** —— 算料、采购基准、MRP 的标准分组口径。
 * 颜色同时登记 color_cn / color_en 两个键(BOM 行可能用任一种写法)。
 */
export function groupPhysicalPieceQty<T extends LineItemQtyShape & {
  style_no?: string | null; color_cn?: string | null; color_en?: string | null;
}>(items: T[] | null | undefined): { byStyle: Map<string, number>; byStyleColor: Map<string, number> } {
  const norm = (s: any) => String(s ?? '').trim().toLowerCase();
  const byStyle = new Map<string, number>();
  const byStyleColor = new Map<string, number>();
  for (const li of items || []) {
    if (!li?.style_no) continue;
    const st = norm(li.style_no);
    const q = getPhysicalPieceQty(li);
    byStyle.set(st, (byStyle.get(st) || 0) + q);
    // ⚠️ 中英色名去重:color_cn 与 color_en 可能是同一个字符串(如都填 'BLACK'),
    //    不去重会往同一个桶加两次 → 件数翻倍 → 多算料(bom.ts 2026-07-04 审计修过同款 bug,不许回潮)。
    for (const c of new Set([norm(li.color_cn), norm(li.color_en)].filter(Boolean))) {
      const k = `${st}¦${c}`;
      byStyleColor.set(k, (byStyleColor.get(k) || 0) + q);
    }
  }
  return { byStyle, byStyleColor };
}

/** 同上,但汇总**商业数量**(套数)——用于报价/客户侧金额。 */
export function groupCommercialQty<T extends LineItemQtyShape & {
  style_no?: string | null; color_cn?: string | null; color_en?: string | null;
}>(items: T[] | null | undefined): { byStyle: Map<string, number>; byStyleColor: Map<string, number> } {
  const norm = (s: any) => String(s ?? '').trim().toLowerCase();
  const byStyle = new Map<string, number>();
  const byStyleColor = new Map<string, number>();
  for (const li of items || []) {
    if (!li?.style_no) continue;
    const st = norm(li.style_no);
    const q = getCommercialQty(li);
    byStyle.set(st, (byStyle.get(st) || 0) + q);
    // 中英色名去重(同 groupPhysicalPieceQty):相同色名不得重复累加
    for (const c of new Set([norm(li.color_cn), norm(li.color_en)].filter(Boolean))) {
      byStyleColor.set(`${st}¦${c}`, (byStyleColor.get(`${st}¦${c}`) || 0) + q);
    }
  }
  return { byStyle, byStyleColor };
}
