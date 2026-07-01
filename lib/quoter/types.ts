/**
 * 报价员模块 — 共享类型定义
 *
 * 与节拍器主系统完全解耦：不要 import 任何 lib/agent 或 lib/domain 的东西
 */

// ════════════════════════════════════════════════
// 品类
// ════════════════════════════════════════════════

export type GarmentType =
  | 'knit_top'       // 针织上衣（T恤/卫衣/连帽衫）
  | 'knit_bottom'    // 针织下装（Legging/瑜伽裤/运动裤）
  | 'woven_pants'    // 梭织长裤
  | 'woven_shorts';  // 梭织短裤

export const GARMENT_TYPE_LABELS: Record<GarmentType, string> = {
  knit_top: '针织上衣',
  knit_bottom: '针织下装',
  woven_pants: '梭织长裤',
  woven_shorts: '梭织短裤',
};

export type KnitTopSubtype = 'tshirt' | 'long_sleeve' | 'sweatshirt' | 'hoodie' | 'tank';
export type KnitBottomSubtype = 'legging' | 'yoga_pants' | 'sweatpants' | 'biker_shorts';
export type WovenPantsSubtype = 'chino' | 'cargo' | 'jogger' | 'dress_pants';
export type WovenShortsSubtype = 'beach' | 'cargo_shorts' | 'hiking_shorts';

export type GarmentSubtype =
  | KnitTopSubtype
  | KnitBottomSubtype
  | WovenPantsSubtype
  | WovenShortsSubtype;

export const SUBTYPE_LABELS: Record<string, string> = {
  tshirt: 'T恤',
  long_sleeve: '长袖',
  sweatshirt: '卫衣',
  hoodie: '连帽衫',
  tank: '背心',
  legging: 'Legging',
  yoga_pants: '瑜伽裤',
  sweatpants: '运动裤',
  biker_shorts: '骑行短裤',
  chino: 'Chino 休闲裤',
  cargo: '工装裤',
  jogger: '束脚运动裤',
  dress_pants: '西裤',
  beach: '沙滩裤',
  cargo_shorts: '工装短裤',
  hiking_shorts: '徒步短裤',
};

// ════════════════════════════════════════════════
// 尺码表
// ════════════════════════════════════════════════

export type StandardSize = 'XXS' | 'XS' | 'S' | 'M' | 'L' | 'XL' | 'XXL' | 'XXXL';

/** 针织上衣尺码表 — 所有关键量值单位 cm */
export interface KnitTopMeasurements {
  chest: number;        // 胸围（1/2 围）
  length: number;       // 衣长
  shoulder?: number;    // 肩宽
  sleeve?: number;      // 袖长
  hem?: number;         // 下摆宽
}

/** 针织下装尺码表 */
export interface KnitBottomMeasurements {
  waist: number;        // 腰围
  hip: number;          // 臀围
  inseam: number;       // 内缝
  outseam?: number;     // 外缝
  thigh?: number;       // 大腿围
  leg_opening?: number; // 裤口围
}

/** 梭织裤装尺码表 */
export interface WovenPantsMeasurements {
  waist: number;
  hip: number;
  inseam: number;
  outseam?: number;
  thigh?: number;
  knee?: number;
  leg_opening?: number;
  front_rise?: number;
  back_rise?: number;
}

export type SizeMeasurements =
  | KnitTopMeasurements
  | KnitBottomMeasurements
  | WovenPantsMeasurements;

export interface SizeChart {
  garment_type: GarmentType;
  primary_size: StandardSize; // 主码（通常 M 或 L）
  sizes: Partial<Record<StandardSize, SizeMeasurements>>;
}

// ════════════════════════════════════════════════
// 面料
// ════════════════════════════════════════════════

export interface FabricInfo {
  fabric_type: string;               // 双面/单面/毛圈/四面弹/全棉斜纹
  composition?: string;              // 95%棉 5%氨纶
  width_cm: number;                  // 幅宽 (150/175/180)
  weight_gsm: number;                // 克重
  shrinkage_pct?: number;            // 缩水率 % (默认 3-5%)
  waste_pct?: number;                // 损耗率 % (默认 8-12%)
  price_per_kg?: number;             // 单价 RMB/KG
}

// ════════════════════════════════════════════════
// 面料单耗计算
// ════════════════════════════════════════════════

export interface FabricConsumptionInput {
  garment_type: GarmentType;
  subtype?: string;
  size_chart: SizeChart;
  fabric: FabricInfo;
  size_distribution?: Partial<Record<StandardSize, number>>; // 可选，用于加权平均
}

export interface FabricConsumptionResult {
  /** 主码单耗（KG/件） */
  primary_size_kg: number;
  /** 平均单耗（KG/件） — 如果提供了 size_distribution，则按尺码加权 */
  avg_kg: number;
  /** 用料面积（平方米/件） */
  area_m2: number;
  /** 计算依据 — 可读性说明 */
  reasoning: string;
  /** 使用的参数 */
  factors: {
    base_area_m2: number;
    shrinkage_pct: number;
    waste_pct: number;
    fabric_weight_gsm: number;
  };
  /** 如果使用了历史数据 RAG，这里列出参考记录 */
  similar_records?: Array<{
    id: string;
    garment_type: string;
    fabric_type: string;
    consumption_kg: number;
    similarity_score: number;
  }>;
  /** 置信度 0-100 */
  confidence: number;
  /** 数据来源 */
  source: 'formula' | 'rag' | 'formula+rag';
}

// ════════════════════════════════════════════════
// 加工费计算
// ════════════════════════════════════════════════

export interface CmtOperation {
  code: string;
  name: string;
  category?: 'cutting' | 'sewing' | 'finishing' | 'packing';
  base_rate_rmb: number;
  complexity_factor?: number; // 0.8/1.0/1.5
}

export interface CmtCalculationInput {
  garment_type: GarmentType;
  subtype?: string;
  complexity: 'simple' | 'standard' | 'complex';
  operations?: CmtOperation[];   // 可选，不填用默认工序库
  factory_rate_multiplier?: number; // 工厂档次调整 (0.9/1.0/1.1)
}

export interface CmtCalculationResult {
  total_rmb: number;
  operations: Array<CmtOperation & { adjusted_rate: number }>;
  reasoning: string;
  confidence: number;
  source: 'rules' | 'rules+ai';
}

// ════════════════════════════════════════════════
// 完整报价
// ════════════════════════════════════════════════

export interface QuoteInput {
  /** 客户引用（customers.id）—— 单一客户真相。子阶段1起新建报价必填 */
  customer_id?: string;
  /** 客户名（显示快照 + 旧链路兼容；不再是客户真相） */
  customer_name?: string;
  style_no?: string;
  style_name?: string;
  garment_type: GarmentType;
  subtype?: string;
  quantity: number;
  size_distribution?: Partial<Record<StandardSize, number>>;
  size_chart: SizeChart;
  fabric: FabricInfo;
  cmt_factory?: string;
  cmt_complexity?: 'simple' | 'standard' | 'complex';
  trim_cost_per_piece?: number;
  packing_cost_per_piece?: number;
  logistics_cost_per_piece?: number;
  margin_rate?: number;
  currency?: 'USD' | 'RMB' | 'EUR';
  exchange_rate?: number;
}

export interface QuoteOutput {
  fabric: FabricConsumptionResult;
  cmt: CmtCalculationResult;
  /** 各项成本（RMB / 件） */
  costs: {
    fabric_rmb: number;
    cmt_rmb: number;
    trim_rmb: number;
    packing_rmb: number;
    logistics_rmb: number;
    subtotal_rmb: number;
  };
  /** 报价（RMB / 件） */
  quote_rmb_per_piece: number;
  /** 报价（目标货币 / 件） */
  quote_currency_per_piece: number;
  /** 总报价 */
  total_currency: number;
  /** 利润率 */
  effective_margin_pct: number;
  /** 整体置信度 */
  overall_confidence: number;
}

// ════════════════════════════════════════════════
// Quote Line（子阶段1：Header + Line 重构）
//
// quote_line 行的插入载荷（不含 DB 自动列 id / created_at / updated_at）。
// 口径与 quoter_quotes(Header) 写入及 20260630 回填 migration 完全一致。
// 行的稳定 uuid 由 DB 默认 gen_random_uuid() 生成（= 未来 Customer PO Line 映射锚）。
// ════════════════════════════════════════════════

export interface QuoteLineRow {
  quote_id: string;
  line_no: number;
  style_no: string | null;
  style_name: string | null;
  garment_type: string | null;
  garment_subtype: string | null;
  color: string | null;
  quantity: number | null;
  size_distribution: Partial<Record<StandardSize, number>> | null;
  fabric_type: string | null;
  fabric_composition: string | null;
  fabric_width_cm: number | null;
  fabric_price_per_kg: number | null;
  fabric_consumption_kg: number | null;
  fabric_cost_per_piece: number | null;
  cmt_factory: string | null;
  cmt_operations: unknown;
  cmt_cost_per_piece: number | null;
  trim_cost_per_piece: number;
  packing_cost_per_piece: number;
  logistics_cost_per_piece: number;
  total_cost_per_piece: number | null;
  margin_rate: number | null;
  quoted_price_per_piece: number | null;
  currency: string | null;
  exchange_rate: number | null;
  status: string;
}

/**
 * 由 Header 输入 + 计算结果派生一条 quote_line 插入载荷。
 * 纯函数、无副作用、可单测。子阶段1每张报价产出 1 行（line_no=1）；
 * 子阶段4多款表单时按 N 行循环复用本函数。
 */
export function buildQuoteLineRow(
  quoteId: string,
  lineNo: number,
  input: QuoteInput,
  result: QuoteOutput,
): QuoteLineRow {
  return {
    quote_id: quoteId,
    line_no: lineNo,
    style_no: input.style_no ?? null,
    style_name: input.style_name ?? null,
    garment_type: input.garment_type ?? null,
    garment_subtype: input.subtype ?? null,
    color: null, // 单款表单无颜色字段；逐色拆行留待子阶段4
    quantity: input.quantity ?? 0,
    size_distribution: input.size_distribution ?? null,
    fabric_type: input.fabric.fabric_type ?? null,
    fabric_composition: input.fabric.composition ?? null,
    fabric_width_cm: input.fabric.width_cm ?? null,
    fabric_price_per_kg: input.fabric.price_per_kg ?? null,
    fabric_consumption_kg: result.fabric.avg_kg,
    fabric_cost_per_piece: result.costs.fabric_rmb,
    cmt_factory: input.cmt_factory ?? null,
    cmt_operations: result.cmt.operations,
    cmt_cost_per_piece: result.costs.cmt_rmb,
    trim_cost_per_piece: input.trim_cost_per_piece ?? 0,
    packing_cost_per_piece: input.packing_cost_per_piece ?? 0,
    logistics_cost_per_piece: input.logistics_cost_per_piece ?? 0,
    total_cost_per_piece: result.costs.subtotal_rmb,
    margin_rate: input.margin_rate ?? 15.0,
    quoted_price_per_piece: result.quote_currency_per_piece,
    currency: input.currency ?? 'USD',
    exchange_rate: input.exchange_rate ?? 7.2,
    status: 'draft',
  };
}

// ════════════════════════════════════════════════
// Quote Version + Approval（子阶段2）
//
// 冻结快照 payload + 毛利门控，均为纯函数，无副作用、可单测。
// Approved 由 quoter_quotes.approved_version 表达，不新增 status 值。
// ════════════════════════════════════════════════

/** 冻结快照载荷（写入 quote_version_snapshot.snapshot jsonb；写后不可改） */
export interface QuoteSnapshot {
  version: number;
  /** 冻结时刻的 Header 行（原样） */
  header: Record<string, unknown>;
  /** 冻结时刻的 Lines 行（原样） */
  lines: Record<string, unknown>[];
}

/**
 * 由已落库的 Header 行 + Line 行组装冻结快照。
 * 不 stamp 时间（freeze 时间由 DB created_at 记录），保证纯函数确定性。
 */
export function buildQuoteSnapshot(
  header: Record<string, unknown> & { version?: number | null },
  lines: Record<string, unknown>[] | null | undefined,
): QuoteSnapshot {
  return {
    version: (header.version as number) ?? 1,
    header,
    lines: lines ?? [],
  };
}

export interface ApprovalGateResult {
  /** 是否需要价格审批权限（存在低于目标毛利的行） */
  needsPriceApproval: boolean;
  /** 命中的低毛利行 */
  lowMarginLines: Array<{ line_no: number | null; margin_rate: number | null }>;
}

/**
 * 毛利门控（§8）：任一行毛利 < 目标毛利 → 需 CAN_APPROVE_PRICE。
 * 无目标毛利（null）→ 不设地板，业务自定快路径。与角色判断解耦，便于单测。
 */
export function evaluateApprovalGate(
  lines: Array<{ line_no?: number | null; margin_rate?: number | null }>,
  marginTarget: number | null | undefined,
): ApprovalGateResult {
  if (marginTarget == null) return { needsPriceApproval: false, lowMarginLines: [] };
  const lowMarginLines = (lines ?? [])
    .filter((l) => l.margin_rate != null && (l.margin_rate as number) < marginTarget)
    .map((l) => ({ line_no: l.line_no ?? null, margin_rate: l.margin_rate ?? null }));
  return { needsPriceApproval: lowMarginLines.length > 0, lowMarginLines };
}
