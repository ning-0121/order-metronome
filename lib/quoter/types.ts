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
