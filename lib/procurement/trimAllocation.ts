// ============================================================
// Trim SKU Allocation —— P0 Domain(纯函数,零 DB / 零 auth / 零 IO)
//
// 消灭的是这道摩擦(证据 #2,2026-08-16 CEO 拍板并入 P0):
//   BOM 录入侧「一行一物料 + 一个总量」没有色×码维度 →
//   多尺码尺码牌表达不了 → 跟单退回 Excel 手抄 →
//   而那 9 个数字(S368/M736/L736/XL368、S300/M600/L600/XL300、4008)
//   **系统在建单时就已经全有了**(order_line_items.sizes)。
//
// 铁律:
//   ① 系统已经知道的数量,不许人再输一遍 —— 本模块负责把它算出来;
//   ② 口径(consumption_basis)未确认**绝不猜** —— 返回 NEEDS_BASIS 交回跟单。
//      「主标听起来像每套」这类联想正是 1022977/1022967 翻倍事故的来源;
//   ③ 数量换算**复用 lib/domain/quantity-engine**,不在这里另写一套乘法。
//      (套数 vs 件数在本项目栽过跟头,见 [[quantity-semantics-invariant]])
//
// 数量语义(2026-08-16 用生产库校准,与 20260622 迁移注释相反 —— 以实测为准):
//   order_line_items.sizes 格子 = **套数**(商业数量),qty_pcs == Σsizes;
//   物理件数 = 套数 × set_multiplier;orders.quantity = Σ(qty_pcs × set_multiplier)。
//   实证:QM-20260717-002 → (960+480+480+480) × 2 = 4800 = orders.quantity ✓
// ============================================================

import {
  resolveQuantityForBasis,
  type QuantityBasis,
  type QuantityContext,
} from '@/lib/domain/quantity-engine';
import { isBasisConfirmed } from './consumption-basis';

/** 跟单在 BOM 页声明的分配意图。NULL/未知 一律按 whole_order(老行为)。 */
export type AllocationMode = 'whole_order' | 'by_style' | 'by_style_color' | 'by_style_color_size';

const MODES = new Set<string>(['whole_order', 'by_style', 'by_style_color', 'by_style_color_size']);

/** 归一化:未声明/脏值 → whole_order。绝不抛错,老数据必须照常跑。 */
export function normalizeAllocationMode(v: unknown): AllocationMode {
  const s = String(v ?? '').trim();
  return MODES.has(s) ? (s as AllocationMode) : 'whole_order';
}

export const ALLOCATION_OPTIONS: Array<{ value: AllocationMode; label: string; hint: string }> = [
  { value: 'whole_order', label: '整单一个数量', hint: '不分款不分色(如整单共用的主标)' },
  { value: 'by_style', label: '按款分', hint: '每个款各一个数量' },
  { value: 'by_style_color', label: '按款×色分', hint: '同款不同色要分开(如色卡、织唛)' },
  { value: 'by_style_color_size', label: '按款×色×码分', hint: '印 SKU 信息、供应商必须分码印(如尺码牌、吊牌)' },
];

/** 订单逐款明细的一格 —— 由 Repository 搬运,Domain 不碰表。 */
export interface StyleMatrixCell {
  styleNo: string;
  productName: string | null;
  colorCn: string | null;
  colorEn: string | null;
  /** 尺码;null = 该款未按码录 */
  size: string | null;
  /** 商业数量(套数)= order_line_items.sizes 格子原值 */
  commercialQty: number;
  /** 件/套(非套装 = 1) */
  setMultiplier: number;
}

/** 与既有 procurement_items.sku_breakdown 的形状**逐字段一致** —— 不造第二套模型。 */
export interface AllocationCell {
  style_no: string;
  product_name: string;
  color_cn: string;
  color_en: string;
  size: string;
  qty: number;
}

export type AllocationStatus =
  /** 算出来了,可直接写 sku_breakdown */
  | 'OK'
  /** 口径未确认 —— 交回跟单,绝不猜 */
  | 'NEEDS_BASIS'
  /** 单耗为空/非正 —— 交回跟单 */
  | 'NEEDS_CONSUMPTION'
  /** 该口径本就不按件数走(整单固定/计量类),分码无意义 */
  | 'NOT_ALLOCATABLE'
  /** 订单还没有逐款明细矩阵(没录富录入表) */
  | 'NO_MATRIX'
  /** 声明的是整单 —— 不分配,走老路径 */
  | 'WHOLE_ORDER';

export interface AllocationResult {
  status: AllocationStatus;
  mode: AllocationMode;
  cells: AllocationCell[];
  /** Σcells.qty */
  total: number;
  /** 说人话,可直接显示给跟单 */
  message: string;
  /** 有格子因单耗非整数向上取整(宁多勿缺) */
  rounded: boolean;
}

/**
 * 分配权重:一格 + 该格按口径解析出的基数(PER_SET→套数,PER_PIECE→件数)。
 *
 * 为什么产出的是**权重**而不是数量:归并侧的权威总量是 material_requirements 算出来的
 * (含大货单耗/损耗/抛量),辅料分配只负责把那个总量**摊到各格**,
 * Σ格 恒等于权威总量 —— 绝不在这里另算一个总量出来变成第二套真相。
 * (BOM 录入侧还没有需求量,那时才用 allocateTrim 直接乘单耗做预览。)
 */
export interface AllocationWeight {
  style_no: string;
  product_name: string;
  color_cn: string;
  color_en: string;
  size: string;
  /** 该格基数(按口径解析后的套数/件数) */
  weight: number;
}

export interface AllocationWeightResult {
  status: AllocationStatus;
  mode: AllocationMode;
  weights: AllocationWeight[];
  message: string;
}

export interface AllocationInput {
  mode: unknown;
  /** BOM 行:限定款(空=整单通用,分配到所有款) */
  styleNo?: string | null;
  /** BOM 行:限定颜色(空=不限色) */
  color?: string | null;
  /** 单件用量 */
  qtyPerPiece?: number | null;
  /** 用量口径(跟单确认过的才算数) */
  consumptionBasis?: string | null;
  /** 订单逐款明细矩阵 */
  matrix: StyleMatrixCell[];
}

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
const txt = (s: unknown) => String(s ?? '').trim();

/** 计量类口径:按 kg/米/平方等走,不是按件数 → 分不了码。 */
const MEASUREMENT = new Set<string>(['PER_KG', 'PER_METER', 'PER_SQUARE_METER', 'PER_YARD', 'PER_PACK']);
/** 固定量口径:整单就这么多,不随件数变 → 分不了码。 */
const FIXED = new Set<string>(['PER_ORDER', 'MANUAL_TOTAL']);

/** 分组键:按 mode 决定粒度。 */
function groupKeyOf(c: StyleMatrixCell, mode: AllocationMode): string {
  const style = txt(c.styleNo);
  const color = norm(c.colorCn) || norm(c.colorEn);
  switch (mode) {
    case 'by_style': return style;
    case 'by_style_color': return `${style}¦${color}`;
    case 'by_style_color_size': return `${style}¦${color}¦${txt(c.size)}`;
    default: return '';
  }
}

/**
 * 把辅料需求按跟单声明的粒度分配到 款/色/码。
 *
 * 数量来源**只有一个**:订单逐款明细矩阵。人不输入任何已有数量。
 * 换算复用 resolveQuantityForBasis —— PER_SET 取套数、PER_PIECE/PER_COMPONENT 取件数,
 * 与全站同一套口径,不在这里重新实现乘法。
 */
export function allocationWeights(input: Omit<AllocationInput, 'qtyPerPiece'>): AllocationWeightResult {
  const mode = normalizeAllocationMode(input.mode);
  const base = { mode, weights: [] as AllocationWeight[] };

  if (mode === 'whole_order') {
    return { ...base, status: 'WHOLE_ORDER', message: '整单一个数量,不分配。' };
  }

  // 先认「认得但拆不了」的口径:PER_KG/MANUAL_TOTAL 等不在跟单可选项里,
  // 若按未确认处理会去催跟单确认一个他根本选不到的口径 —— 报错要说真话。
  const declared = txt(input.consumptionBasis).toUpperCase();
  if (FIXED.has(declared) || MEASUREMENT.has(declared)) {
    return {
      ...base,
      status: 'NOT_ALLOCATABLE',
      message: `该物料口径是「${FIXED.has(declared) ? '整单固定' : '按计量单位'}」,数量不随件数变,不按款色码拆分。`,
    };
  }

  // ② 口径未确认绝不猜 —— 猜错数量直接差一倍
  if (!isBasisConfirmed(input.consumptionBasis)) {
    return {
      ...base,
      status: 'NEEDS_BASIS',
      message: '未确认用量口径(每套/每件/每部件/整单固定),不能按款色码分配 —— 系统不会替你猜。',
    };
  }
  const basis = input.consumptionBasis as QuantityBasis;

  // BOM 行限定的款/色(空 = 不限,分配到全部)
  const wantStyle = txt(input.styleNo);
  const wantColor = norm(input.color);
  const matrix = (input.matrix || []).filter((c) => {
    if (!c || !(Number(c.commercialQty) > 0)) return false;
    if (wantStyle && txt(c.styleNo) !== wantStyle) return false;
    if (wantColor && norm(c.colorCn) !== wantColor && norm(c.colorEn) !== wantColor) return false;
    // 按码分配却没有码 → 该行进不了(交回跟单去富录入表补码)
    if (mode === 'by_style_color_size' && !txt(c.size)) return false;
    return true;
  });

  if (matrix.length === 0) {
    return {
      ...base,
      status: 'NO_MATRIX',
      message: mode === 'by_style_color_size'
        ? '订单逐款明细里没有该物料对应的尺码数量,无法按码分配 —— 请先在订单「逐款明细」补齐尺码。'
        : '订单逐款明细里没有该物料对应的款/色数量,无法分配。',
    };
  }

  // 同一分组键可能来自多行(同款同色同码分散录入)→ 先按键累加商业数量
  const groups = new Map<string, { cell: StyleMatrixCell; commercial: number; physical: number }>();
  for (const c of matrix) {
    const key = groupKeyOf(c, mode);
    const setMul = Number(c.setMultiplier) > 0 ? Number(c.setMultiplier) : 1;
    const commercial = Number(c.commercialQty);
    const g = groups.get(key);
    if (g) {
      g.commercial += commercial;
      g.physical += commercial * setMul;
    } else {
      groups.set(key, { cell: c, commercial, physical: commercial * setMul });
    }
  }

  const weights: AllocationWeight[] = [];
  for (const g of groups.values()) {
    // ③ 复用全站口径:PER_SET→套数,PER_PIECE/PER_COMPONENT→件数
    const ctx: QuantityContext = {
      physicalQuantity: g.physical,
      commercialQuantity: g.commercial,
      commercialUnit: null,
      componentsPerCommercialUnit: null,
      source: 'explicit_unit',
      needsReview: false,
      reviewReason: null,
    };
    const resolved = resolveQuantityForBasis(ctx, basis);
    if (resolved.status !== 'OK' || !(resolved.quantity > 0)) continue;
    weights.push({
      style_no: txt(g.cell.styleNo),
      product_name: txt(g.cell.productName),
      color_cn: txt(g.cell.colorCn),
      color_en: txt(g.cell.colorEn),
      size: mode === 'by_style_color_size' ? txt(g.cell.size) : '',
      weight: resolved.quantity,
    });
  }

  if (weights.length === 0) {
    return { ...base, status: 'NO_MATRIX', message: '按当前口径算出的各格基数都是 0,未生成分配。' };
  }

  return {
    status: 'OK',
    mode,
    weights,
    message: `可按${mode === 'by_style_color_size' ? '款×色×码' : mode === 'by_style_color' ? '款×色' : '款'}分配 ${weights.length} 格。`,
  };
}

export function allocateTrim(input: AllocationInput): AllocationResult {
  const w = allocationWeights(input);
  const base = { mode: w.mode, cells: [] as AllocationCell[], total: 0, rounded: false };
  if (w.status !== 'OK') return { ...base, status: w.status, message: w.message };

  const consumption = Number(input.qtyPerPiece);
  if (!Number.isFinite(consumption) || consumption <= 0) {
    return { ...base, status: 'NEEDS_CONSUMPTION', message: '单件用量为空,无法算出各款/色/码的数量。' };
  }

  const cells: AllocationCell[] = [];
  let total = 0;
  let rounded = false;
  for (const g of w.weights) {
    const exact = g.weight * consumption;
    // 辅料是可数件(个/条/张)→ 非整数向上取整,宁多勿缺(与归并侧同口径)
    const qty = Number.isInteger(exact) ? exact : Math.ceil(exact - 1e-9);
    if (qty !== exact) rounded = true;
    if (qty <= 0) continue;
    const { weight: _w, ...cell } = g;
    cells.push({ ...cell, qty });
    total += qty;
  }

  if (cells.length === 0) {
    return { ...base, status: 'NO_MATRIX', message: '按当前口径算出的各格数量都是 0,未生成分配。' };
  }

  const mode = w.mode;

  return {
    status: 'OK',
    mode,
    cells,
    total,
    rounded,
    message: `已按${mode === 'by_style_color_size' ? '款×色×码' : mode === 'by_style_color' ? '款×色' : '款'}分配 ${cells.length} 格,合计 ${total}${rounded ? '(含向上取整)' : ''}。`,
  };
}

/**
 * 整单总量(不分配时用):Σ 矩阵 × 口径 × 单耗。
 * 用于「吊卡/洗标 4008」这类 —— 两张单求和也是系统算,不让人加。
 */
export function totalFromMatrix(input: Omit<AllocationInput, 'mode'>): number | null {
  const r = allocateTrim({ ...input, mode: 'by_style_color_size', matrix: input.matrix });
  if (r.status === 'OK') return r.total;
  // 没有码就退到款×色粒度(总量一样,只是格子粗)
  const c = allocateTrim({ ...input, mode: 'by_style_color', matrix: input.matrix });
  return c.status === 'OK' ? c.total : null;
}
