/**
 * 生产排单 P1 —— 纯匹配/派生逻辑,零副作用,server/client 共用。
 * 工厂能力 vs 订单要求的匹配,不硬拦(建议),生产主管决策。
 */

export const QUALITY_GRADES = ['高', '中', '跑量'] as const;
export const WEAVE_TYPES = ['针织', '梭织'] as const;
export const ORDER_CAPABILITIES = ['清加工', '经销单', '委托加工'] as const;

export interface FactoryCaps {
  id: string;
  factory_name: string;
  product_categories?: string[] | null;   // 擅长品类
  quality_grades?: string[] | null;        // 高/中/跑量
  weave_types?: string[] | null;           // 针织/梭织
  can_package?: boolean | null;
  order_capabilities?: string[] | null;    // 清加工/经销单/委托加工
  monthly_capacity?: number | null;
}

export interface OrderReq {
  product_category?: string | null;   // 产品品类(款级/单级)
  quality_grade?: string | null;      // 高/中/跑量
  weave_type?: string | null;         // 针织/梭织
  needs_package?: boolean | null;     // 要不要包装
  order_capability?: string | null;   // 清加工/经销单/委托加工(派生)
}

export interface MatchResult {
  category: boolean | null;   // null = 订单未指定该要求,不参与判定
  quality: boolean | null;
  weave: boolean | null;
  packaging: boolean | null;
  orderType: boolean | null;
  hardMiss: number;           // 明确不满足的项数(越少越好)
  allOk: boolean;             // 所有已指定的要求都满足
}

/** 订单类型派生:经销(trade)=经销单;客供料=委托加工;其余=清加工。 */
export function deriveOrderCapability(opts: { orderPurpose?: string | null; hasCustomerSupplied?: boolean }): string {
  if (String(opts.orderPurpose || '').toLowerCase() === 'trade') return '经销单';
  if (opts.hasCustomerSupplied) return '委托加工';
  return '清加工';
}

const has = (arr: any, v: any): boolean => Array.isArray(arr) && v != null && v !== '' && arr.map(String).includes(String(v));

/** 工厂能力 vs 订单要求。订单某项没填 → 该项 null(不判定)。 */
export function matchFactory(f: FactoryCaps, req: OrderReq): MatchResult {
  const category = req.product_category ? has(f.product_categories, req.product_category) : null;
  const quality = req.quality_grade ? has(f.quality_grades, req.quality_grade) : null;
  const weave = req.weave_type ? has(f.weave_types, req.weave_type) : null;
  const packaging = req.needs_package == null ? null : (req.needs_package ? !!f.can_package : true);
  const orderType = req.order_capability ? has(f.order_capabilities, req.order_capability) : null;
  const flags = [category, quality, weave, packaging, orderType];
  const hardMiss = flags.filter((x) => x === false).length;
  const allOk = flags.every((x) => x !== false);
  return { category, quality, weave, packaging, orderType, hardMiss, allOk };
}

/** 排序分:全匹配优先 → 不匹配项少 → 剩余产能多 → 准时率高。分越大越靠前。 */
export function rankScore(m: MatchResult, remaining: number | null, onTimeRate: number | null): number {
  let s = 0;
  s += m.allOk ? 100000 : 0;
  s -= m.hardMiss * 20000;
  s += Math.max(0, Math.min(remaining ?? 0, 100000)) / 10;   // 剩余产能(封顶,权重小)
  s += (onTimeRate ?? 0) * 50;                                 // 准时率 0-100
  return Math.round(s);
}
