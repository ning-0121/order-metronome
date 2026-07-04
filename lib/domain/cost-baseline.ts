/**
 * 报价基线对照(纯函数)—— 单一真相:报价基线 vs 实际(大货单耗 / 采购单价)。
 * 用户拍板:超 0% 即报警(容差 0),超出需财务审批。
 * 供 BOM(超单耗)/核料(超单耗+超价)/辅料(超总价)三点对照。
 */

export interface BaselineLine {
  style_no?: string | null;             // 款号(报价单每款一行,单耗按款不同)
  material_name: string;
  color?: string | null;
  category?: string | null;
  quote_consumption?: number | null;   // 报价单耗
  quote_unit_price?: number | null;     // 报价单价
}

export interface BaselineMatch {
  matched: boolean;
  quote_consumption: number | null;
  quote_unit_price: number | null;
}

const norm = (s?: string | null): string => (s || '').trim().toLowerCase();

/**
 * 按「物料(+颜色)」匹配报价基线。优先级:
 *   1) 同物料 + 同颜色(基线该行指定了颜色)
 *   2) 同物料 + 基线颜色为空(通用,适用所有颜色)
 *   3) 同物料任一行(兜底)
 * 匹配不到 → matched=false(无基线,不参与超出判定)。
 */
export function matchBaseline(lines: BaselineLine[], material: string, color?: string | null, style?: string | null): BaselineMatch {
  const miss: BaselineMatch = { matched: false, quote_consumption: null, quote_unit_price: null };
  const m = norm(material);
  if (!m || !Array.isArray(lines) || lines.length === 0) return miss;
  let sameMat = lines.filter((l) => norm(l.material_name) === m);
  if (sameMat.length === 0) return miss;

  // 款优先:基线有款号时,先在同款里匹配;同款无命中再退回不分款(向后兼容旧基线)。
  const s = norm(style);
  const hasStyleInBaseline = sameMat.some((l) => norm(l.style_no));
  if (s && hasStyleInBaseline) {
    const sameStyle = sameMat.filter((l) => norm(l.style_no) === s);
    if (sameStyle.length > 0) sameMat = sameStyle;   // 命中同款 → 只在同款里挑颜色
  }

  const c = norm(color);
  const line =
    (c ? sameMat.find((l) => norm(l.color) === c) : undefined)         // 同料(同款)同色
    ?? sameMat.find((l) => !norm(l.color))                            // 同料·基线通用色
    ?? sameMat[0];                                                    // 兜底
  return {
    matched: true,
    quote_consumption: line.quote_consumption ?? null,
    quote_unit_price: line.quote_unit_price ?? null,
  };
}

export interface OverBaselineResult {
  over_consumption: boolean;
  over_price: boolean;
  /** 超单耗百分比(actual 比基线高多少 %),不超或无基线 → null */
  consumption_over_pct: number | null;
  price_over_pct: number | null;
  quote_consumption: number | null;
  quote_unit_price: number | null;
}

/**
 * 超基线判定(容差 0:actual 严格大于基线即超)。基线值为空/actual 为空 → 该维不判超。
 */
export function checkOverBaseline(
  base: BaselineMatch,
  actualConsumption?: number | null,
  actualPrice?: number | null,
): OverBaselineResult {
  const qc = base.quote_consumption;
  const qp = base.quote_unit_price;
  const ac = actualConsumption ?? null;
  const ap = actualPrice ?? null;
  const overC = qc != null && qc > 0 && ac != null && ac > qc;
  const overP = qp != null && qp > 0 && ap != null && ap > qp;
  const pct = (a: number, b: number) => Math.round(((a - b) / b) * 1000) / 10;
  return {
    over_consumption: overC,
    over_price: overP,
    consumption_over_pct: overC ? pct(ac!, qc!) : null,
    price_over_pct: overP ? pct(ap!, qp!) : null,
    quote_consumption: qc,
    quote_unit_price: qp,
  };
}

/**
 * 辅料超总价:Σ(采购价×量) vs 报价辅料预算。超即报警。
 * budget 为空 → 不判超。
 */
export function checkTrimTotalOverBudget(
  actualTotal: number,
  quoteBudget: number | null | undefined,
): { over: boolean; over_pct: number | null } {
  if (quoteBudget == null || quoteBudget <= 0) return { over: false, over_pct: null };
  const over = actualTotal > quoteBudget;
  return { over, over_pct: over ? Math.round(((actualTotal - quoteBudget) / quoteBudget) * 1000) / 10 : null };
}
