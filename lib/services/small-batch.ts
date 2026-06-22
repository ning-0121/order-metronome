/**
 * 碎单预警 —— 纯计算,无 DB 依赖,可单测。
 *
 * 业务背景:部分客户(如 EHL)订单"数量少、颜色多,每色才 100 多件",
 * 碎单工艺/排产成本高,但报价仍按大货价 → 恐亏损。
 * 规则:任一颜色件数 < 阈值(默认 150)→ 触发预警,站内通知业务主管 + CEO。
 *
 * 优先用 order_line_items 逐色精确判定;老单无明细时回退「总件数 ÷ 颜色数」平均值估算。
 */

/** 每色件数低于此值 → 碎单预警(CEO 2026-06-22 定:150 卡"100 多件"的痛点,300 误报太多) */
export const SMALL_BATCH_THRESHOLD = 150;

export interface SmallColor {
  style_no: string | null;
  color: string;
  qty_pcs: number;
}

export interface SmallBatchResult {
  /** 是否触发预警 */
  triggered: boolean;
  /** 实际使用的阈值(件/色) */
  threshold: number;
  /** true=逐色精确(有 order_line_items);false=平均值估算(老单) */
  precise: boolean;
  /** 有效颜色数 */
  totalColors: number;
  /** 低于阈值的颜色(按件数升序) */
  smallColors: SmallColor[];
  /** 最小颜色件数(精确)或平均每色件数(估算);无数据为 null */
  minColorQty: number | null;
}

/** 逐色精确判定:输入 order_line_items 风格的行(每行 = 一个款×色) */
export function assessSmallBatchFromLineItems(
  items: Array<{
    style_no?: string | null;
    color_cn?: string | null;
    color_en?: string | null;
    qty_pcs?: number | null;
  }>,
  threshold: number = SMALL_BATCH_THRESHOLD,
): SmallBatchResult {
  const colors: SmallColor[] = (items || [])
    .map((it) => ({
      style_no: it.style_no ?? null,
      color: it.color_cn || it.color_en || '未命名色',
      qty_pcs: Number(it.qty_pcs ?? 0),
    }))
    .filter((c) => c.qty_pcs > 0);

  const small = colors
    .filter((c) => c.qty_pcs < threshold)
    .sort((a, b) => a.qty_pcs - b.qty_pcs);
  const minColorQty = colors.length ? Math.min(...colors.map((c) => c.qty_pcs)) : null;

  return {
    triggered: small.length > 0,
    threshold,
    precise: true,
    totalColors: colors.length,
    smallColors: small,
    minColorQty,
  };
}

/** 平均值回退:老单无逐色明细时,用「总件数 ÷ 颜色数」估算每色平均件数 */
export function assessSmallBatchFromAverage(
  totalQty: number,
  colorCount: number,
  threshold: number = SMALL_BATCH_THRESHOLD,
): SmallBatchResult {
  const colors = colorCount > 0 ? colorCount : 0;
  const avg = colors > 0 ? Math.round((totalQty || 0) / colors) : null;
  const triggered = avg !== null && avg < threshold;

  return {
    triggered,
    threshold,
    precise: false,
    totalColors: colors,
    smallColors: triggered ? [{ style_no: null, color: '平均每色', qty_pcs: avg! }] : [],
    minColorQty: avg,
  };
}
