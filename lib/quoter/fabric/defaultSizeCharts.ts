/**
 * 默认标准尺码表模板 — Phase 1 种子数据
 *
 * 数据来源：Qimo 外贸订单常见尺码表综合。CEO 后续可以在 UI 里编辑。
 * 所有尺寸单位 cm。
 *
 * 使用方式：
 *   const chart = DEFAULT_SIZE_CHARTS.knit_top_tshirt;
 *   // 用户可以基于此微调
 */

import type { GarmentType, KnitTopMeasurements, KnitBottomMeasurements, WovenPantsMeasurements, StandardSize } from '../types';

export interface SizeChartTemplate {
  garment_type: GarmentType;
  subtype: string;
  label: string;
  primary_size: StandardSize;
  sizes: Partial<Record<StandardSize, KnitTopMeasurements | KnitBottomMeasurements | WovenPantsMeasurements>>;
}

// 针织 T 恤 — 男女通用标准码
const KNIT_TSHIRT: SizeChartTemplate = {
  garment_type: 'knit_top',
  subtype: 'tshirt',
  label: '针织 T 恤（标准）',
  primary_size: 'M',
  sizes: {
    XS: { chest: 46, length: 66, shoulder: 42, sleeve: 18 },
    S:  { chest: 49, length: 68, shoulder: 44, sleeve: 19 },
    M:  { chest: 52, length: 70, shoulder: 46, sleeve: 20 },
    L:  { chest: 55, length: 72, shoulder: 48, sleeve: 21 },
    XL: { chest: 58, length: 74, shoulder: 50, sleeve: 22 },
    XXL:{ chest: 61, length: 76, shoulder: 52, sleeve: 23 },
  },
};

const KNIT_LONG_SLEEVE: SizeChartTemplate = {
  garment_type: 'knit_top',
  subtype: 'long_sleeve',
  label: '针织长袖',
  primary_size: 'M',
  sizes: {
    S:  { chest: 49, length: 68, shoulder: 44, sleeve: 58 },
    M:  { chest: 52, length: 70, shoulder: 46, sleeve: 60 },
    L:  { chest: 55, length: 72, shoulder: 48, sleeve: 62 },
    XL: { chest: 58, length: 74, shoulder: 50, sleeve: 64 },
  },
};

const KNIT_HOODIE: SizeChartTemplate = {
  garment_type: 'knit_top',
  subtype: 'hoodie',
  label: '针织连帽衫',
  primary_size: 'M',
  sizes: {
    S:  { chest: 54, length: 68, shoulder: 48, sleeve: 60 },
    M:  { chest: 57, length: 70, shoulder: 50, sleeve: 62 },
    L:  { chest: 60, length: 72, shoulder: 52, sleeve: 64 },
    XL: { chest: 63, length: 74, shoulder: 54, sleeve: 66 },
  },
};

// 针织 Legging — Qimo 主力品类
const KNIT_LEGGING: SizeChartTemplate = {
  garment_type: 'knit_bottom',
  subtype: 'legging',
  label: '针织 Legging（七/九分）',
  primary_size: 'M',
  sizes: {
    XS: { waist: 28, hip: 84, inseam: 63, outseam: 88, thigh: 48, leg_opening: 22 },
    S:  { waist: 30, hip: 88, inseam: 64, outseam: 89, thigh: 50, leg_opening: 23 },
    M:  { waist: 32, hip: 92, inseam: 65, outseam: 90, thigh: 52, leg_opening: 24 },
    L:  { waist: 34, hip: 96, inseam: 66, outseam: 91, thigh: 54, leg_opening: 25 },
    XL: { waist: 36, hip: 100, inseam: 67, outseam: 92, thigh: 56, leg_opening: 26 },
  },
};

const KNIT_BIKER_SHORTS: SizeChartTemplate = {
  garment_type: 'knit_bottom',
  subtype: 'biker_shorts',
  label: '针织骑行短裤',
  primary_size: 'M',
  sizes: {
    XS: { waist: 28, hip: 84, inseam: 18, outseam: 33, thigh: 48, leg_opening: 34 },
    S:  { waist: 30, hip: 88, inseam: 19, outseam: 34, thigh: 50, leg_opening: 36 },
    M:  { waist: 32, hip: 92, inseam: 20, outseam: 35, thigh: 52, leg_opening: 38 },
    L:  { waist: 34, hip: 96, inseam: 21, outseam: 36, thigh: 54, leg_opening: 40 },
    XL: { waist: 36, hip: 100, inseam: 22, outseam: 37, thigh: 56, leg_opening: 42 },
  },
};

// 梭织长裤
const WOVEN_CHINO: SizeChartTemplate = {
  garment_type: 'woven_pants',
  subtype: 'chino',
  label: '梭织 Chino 休闲裤',
  primary_size: 'M',
  sizes: {
    S:  { waist: 38, hip: 48, inseam: 80, outseam: 104, thigh: 30, knee: 22, leg_opening: 19, front_rise: 25, back_rise: 36 },
    M:  { waist: 40, hip: 50, inseam: 80, outseam: 105, thigh: 31, knee: 22, leg_opening: 19, front_rise: 26, back_rise: 37 },
    L:  { waist: 42, hip: 52, inseam: 81, outseam: 106, thigh: 32, knee: 23, leg_opening: 20, front_rise: 26, back_rise: 38 },
    XL: { waist: 44, hip: 54, inseam: 81, outseam: 107, thigh: 33, knee: 23, leg_opening: 20, front_rise: 27, back_rise: 39 },
  },
};

// 梭织短裤
const WOVEN_BEACH_SHORTS: SizeChartTemplate = {
  garment_type: 'woven_shorts',
  subtype: 'beach',
  label: '梭织沙滩裤',
  primary_size: 'M',
  sizes: {
    S:  { waist: 38, hip: 50, inseam: 18, outseam: 46, thigh: 32, leg_opening: 30, front_rise: 27, back_rise: 38 },
    M:  { waist: 40, hip: 52, inseam: 19, outseam: 47, thigh: 33, leg_opening: 31, front_rise: 28, back_rise: 39 },
    L:  { waist: 42, hip: 54, inseam: 20, outseam: 48, thigh: 34, leg_opening: 32, front_rise: 28, back_rise: 40 },
    XL: { waist: 44, hip: 56, inseam: 20, outseam: 48, thigh: 35, leg_opening: 33, front_rise: 29, back_rise: 41 },
  },
};

export const DEFAULT_SIZE_CHARTS: Record<string, SizeChartTemplate> = {
  knit_top_tshirt: KNIT_TSHIRT,
  knit_top_long_sleeve: KNIT_LONG_SLEEVE,
  knit_top_hoodie: KNIT_HOODIE,
  knit_bottom_legging: KNIT_LEGGING,
  knit_bottom_biker_shorts: KNIT_BIKER_SHORTS,
  woven_pants_chino: WOVEN_CHINO,
  woven_shorts_beach: WOVEN_BEACH_SHORTS,
};

export function getChartOptions(garmentType: GarmentType): SizeChartTemplate[] {
  return Object.values(DEFAULT_SIZE_CHARTS).filter(c => c.garment_type === garmentType);
}
