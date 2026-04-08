/**
 * 面料单耗计算器 — Phase 1: 纯公式法
 *
 * 算法思路：
 *   1. 根据尺码表关键尺寸，估算衣片展开面积（每件的面料覆盖面积）
 *   2. 面积 × 克重 = 基础重量
 *   3. × (1 + 缩水率) × (1 + 损耗率) = 实际单耗
 *   4. 不同幅宽 / 不同品类有固定的经验修正系数
 *
 * Phase 2 会在此基础上叠加 RAG：
 *   - 查 quoter_fabric_records 找相似历史单
 *   - 用历史实测值校准公式结果
 *   - 偏离度大时提示"公式 vs 历史"对比
 */

import type {
  FabricConsumptionInput,
  FabricConsumptionResult,
  GarmentType,
  KnitTopMeasurements,
  KnitBottomMeasurements,
  WovenPantsMeasurements,
  SizeMeasurements,
  StandardSize,
} from '../types';

// ════════════════════════════════════════════════
// 经验系数表（CEO 确认后可改）
// ════════════════════════════════════════════════

const DEFAULT_SHRINKAGE_PCT: Record<GarmentType, number> = {
  knit_top: 4,       // 针织缩水 3-5%
  knit_bottom: 4,
  woven_pants: 2,    // 梭织相对稳定
  woven_shorts: 2,
};

const DEFAULT_WASTE_PCT: Record<GarmentType, number> = {
  knit_top: 10,      // 针织排料损耗 8-12%
  knit_bottom: 10,
  woven_pants: 12,   // 梭织条纹对格损耗略高
  woven_shorts: 12,
};

const DEFAULT_FABRIC_WEIGHT_GSM: Record<GarmentType, number> = {
  knit_top: 200,     // 常见 T 恤克重
  knit_bottom: 260,  // Legging 常见
  woven_pants: 180,  // Chino 常见
  woven_shorts: 140, // 沙滩裤常见
};

/**
 * 品类面积系数
 *
 * 原理：一件衣服的面料展开面积 ≈ 关键量值相乘 × 系数 × 2（前后片）
 *
 * 针织上衣：胸围 × 衣长 × 2 × k
 *   - k 系数 ≈ 1.05（含肩袖展开、接缝、贴边）
 *   - 有袖：+ 袖长 × 袖围 × 2
 *   - hoodie 帽子：+ 0.15 m²
 *
 * 针织下装：腰围 × 内缝 × 2 × k
 *   - k ≈ 1.10（含前后片 + 腰头 + 裤头罗纹）
 *
 * 梭织裤装：与针织下装类似，但 k ≈ 1.15（缝份更宽、省道多）
 */
const SILHOUETTE_FACTOR: Record<GarmentType, number> = {
  knit_top: 1.05,
  knit_bottom: 1.10,
  woven_pants: 1.15,
  woven_shorts: 1.15,
};

/** 主码到其他尺码的面积缩放系数（经验值） */
const SIZE_AREA_SCALE: Record<StandardSize, number> = {
  XXS: 0.82,
  XS: 0.88,
  S: 0.94,
  M: 1.00,
  L: 1.06,
  XL: 1.13,
  XXL: 1.21,
  XXXL: 1.30,
};

// ════════════════════════════════════════════════
// 尺码 → 面积（m²）
// ════════════════════════════════════════════════

function calcKnitTopArea(m: KnitTopMeasurements): number {
  // 前后片：胸围(1/2围) × 2 × 衣长 × 2 = 单件平铺面积
  // 注：1/2 胸围乘以 2 才是整个围度；实际面料是围度（cm），转成 cm² 再换 m²
  const bodyArea = (m.chest * 2) * m.length * 2; // cm²

  // 袖子（如果有）— 近似 袖长 × 1/2 袖围 × 2 × 2（两只袖）
  // 简化：按 袖长 × 20cm 平均袖围 × 2 只 × 2 片
  const sleeveArea = (m.sleeve || 0) > 0 ? (m.sleeve || 0) * 20 * 4 : 0;

  const totalCm2 = bodyArea + sleeveArea;
  return totalCm2 / 10000; // cm² → m²
}

function calcKnitBottomArea(m: KnitBottomMeasurements): number {
  // 前后片：腰围 × 内缝 × 2（前后）
  const legArea = m.waist * m.inseam * 2; // cm²
  // 裤头罗纹：腰围 × 4cm × 2
  const waistband = m.waist * 4 * 2;
  return (legArea + waistband) / 10000;
}

function calcWovenPantsArea(m: WovenPantsMeasurements): number {
  // 梭织裤：腰围 × 外缝 × 2 + 腰头
  const legArea = m.waist * (m.outseam || m.inseam + 10) * 2;
  const waistband = m.waist * 4 * 2;
  // 梭织多一些省道/口袋 → +5%
  return ((legArea + waistband) * 1.05) / 10000;
}

function calcArea(garmentType: GarmentType, m: SizeMeasurements): number {
  switch (garmentType) {
    case 'knit_top':
      return calcKnitTopArea(m as KnitTopMeasurements);
    case 'knit_bottom':
      return calcKnitBottomArea(m as KnitBottomMeasurements);
    case 'woven_pants':
    case 'woven_shorts':
      return calcWovenPantsArea(m as WovenPantsMeasurements);
  }
}

// ════════════════════════════════════════════════
// 主计算函数
// ════════════════════════════════════════════════

export function calculateFabricConsumption(
  input: FabricConsumptionInput,
): FabricConsumptionResult {
  const { garment_type, size_chart, fabric, size_distribution } = input;

  // 1. 获取主码尺寸
  const primarySize = size_chart.primary_size || 'M';
  const primaryMeasurements = size_chart.sizes[primarySize];
  if (!primaryMeasurements) {
    throw new Error(`尺码表缺少主码 ${primarySize} 的数据`);
  }

  // 2. 计算主码面积（m²）
  const baseAreaM2 = calcArea(garment_type, primaryMeasurements);
  const silhouetteFactor = SILHOUETTE_FACTOR[garment_type];
  const adjustedAreaM2 = baseAreaM2 * silhouetteFactor;

  // 3. 克重 × 面积 = 基础重量（KG）
  const weightGsm = fabric.weight_gsm || DEFAULT_FABRIC_WEIGHT_GSM[garment_type];
  const baseWeightKg = (adjustedAreaM2 * weightGsm) / 1000;

  // 4. 应用缩水率 + 损耗率
  const shrinkagePct = fabric.shrinkage_pct ?? DEFAULT_SHRINKAGE_PCT[garment_type];
  const wastePct = fabric.waste_pct ?? DEFAULT_WASTE_PCT[garment_type];
  const primarySizeKg = baseWeightKg * (1 + shrinkagePct / 100) * (1 + wastePct / 100);

  // 5. 幅宽修正：窄幅（< 160cm）损耗更高
  let widthAdjustment = 1.0;
  if (fabric.width_cm && fabric.width_cm < 160) {
    widthAdjustment = 1.05; // 窄幅 +5%
  } else if (fabric.width_cm && fabric.width_cm > 180) {
    widthAdjustment = 0.97; // 超宽 -3%
  }
  const primaryFinal = primarySizeKg * widthAdjustment;

  // 6. 按尺码分布加权平均（如果提供）
  let avgKg = primaryFinal;
  if (size_distribution) {
    let totalQty = 0;
    let weightedSum = 0;
    for (const [size, qty] of Object.entries(size_distribution)) {
      if (!qty || qty <= 0) continue;
      const scale = SIZE_AREA_SCALE[size as StandardSize] || 1.0;
      weightedSum += primaryFinal * scale * qty;
      totalQty += qty;
    }
    if (totalQty > 0) {
      avgKg = weightedSum / totalQty;
    }
  }

  // 7. 生成可读性说明
  const reasoning = [
    `品类：${garment_type}（主码 ${primarySize}）`,
    `展开面积：${adjustedAreaM2.toFixed(3)} m² (基础 ${baseAreaM2.toFixed(3)} × 轮廓系数 ${silhouetteFactor})`,
    `基础重量：${baseWeightKg.toFixed(3)} KG (面积 × ${weightGsm} gsm)`,
    `缩水率 ${shrinkagePct}% + 损耗率 ${wastePct}%`,
    fabric.width_cm
      ? `幅宽 ${fabric.width_cm}cm ${widthAdjustment > 1 ? '(窄幅 +5%)' : widthAdjustment < 1 ? '(超宽 -3%)' : ''}`
      : '幅宽未指定（使用默认值）',
    `主码单耗：${primaryFinal.toFixed(3)} KG/件`,
    size_distribution ? `按尺码分布加权平均：${avgKg.toFixed(3)} KG/件` : '',
  ]
    .filter(Boolean)
    .join('\n');

  // 8. 置信度评估
  let confidence = 70; // 纯公式基础置信度
  if (!fabric.weight_gsm) confidence -= 15; // 克重缺失
  if (!fabric.width_cm) confidence -= 10;  // 幅宽缺失
  if (!primaryMeasurements || Object.keys(primaryMeasurements).length < 2) {
    confidence -= 20; // 尺码表太简单
  }
  confidence = Math.max(30, confidence);

  return {
    primary_size_kg: Number(primaryFinal.toFixed(3)),
    avg_kg: Number(avgKg.toFixed(3)),
    area_m2: Number(adjustedAreaM2.toFixed(3)),
    reasoning,
    factors: {
      base_area_m2: Number(baseAreaM2.toFixed(3)),
      shrinkage_pct: shrinkagePct,
      waste_pct: wastePct,
      fabric_weight_gsm: weightGsm,
    },
    confidence,
    source: 'formula',
  };
}
