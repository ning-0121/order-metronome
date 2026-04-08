/**
 * 默认工序库 — Phase 1 种子数据
 *
 * 工价参考值基于 2025-2026 年中国长三角 / 珠三角一般水平。
 * 实际报价时会根据工厂档次（low/standard/premium）乘以系数 (0.85/1.0/1.15)。
 *
 * CEO 可以在训练数据管理页编辑工价。
 */

import type { CmtOperation, GarmentType } from '../types';

export interface DefaultOperationTemplate extends CmtOperation {
  garment_types: GarmentType[];
  display_order: number;
  is_default: boolean;
}

// ════════════════════════════════════════════════
// 针织上衣 — 基础 T 恤 ≈ 2.6 RMB（CEO 2026-04-09 校准）
// ════════════════════════════════════════════════

const KNIT_TOP_OPS: DefaultOperationTemplate[] = [
  { code: 'cut_body', name: '裁床（衣身）', category: 'cutting', base_rate_rmb: 0.25, complexity_factor: 1.0, garment_types: ['knit_top'], display_order: 1, is_default: true },
  { code: 'cut_sleeve', name: '裁床（袖子）', category: 'cutting', base_rate_rmb: 0.15, complexity_factor: 1.0, garment_types: ['knit_top'], display_order: 2, is_default: true },
  { code: 'sew_shoulder', name: '合肩', category: 'sewing', base_rate_rmb: 0.20, complexity_factor: 1.0, garment_types: ['knit_top'], display_order: 3, is_default: true },
  { code: 'attach_collar', name: '上领', category: 'sewing', base_rate_rmb: 0.30, complexity_factor: 1.0, garment_types: ['knit_top'], display_order: 4, is_default: true },
  { code: 'attach_sleeve', name: '上袖', category: 'sewing', base_rate_rmb: 0.25, complexity_factor: 1.0, garment_types: ['knit_top'], display_order: 5, is_default: true },
  { code: 'sew_side', name: '合侧缝', category: 'sewing', base_rate_rmb: 0.25, complexity_factor: 1.0, garment_types: ['knit_top'], display_order: 6, is_default: true },
  { code: 'hem_bottom', name: '下摆卷边', category: 'sewing', base_rate_rmb: 0.20, complexity_factor: 1.0, garment_types: ['knit_top'], display_order: 7, is_default: true },
  { code: 'hem_sleeve', name: '袖口卷边', category: 'sewing', base_rate_rmb: 0.15, complexity_factor: 1.0, garment_types: ['knit_top'], display_order: 8, is_default: true },
  { code: 'attach_label', name: '钉唛/主标洗标', category: 'sewing', base_rate_rmb: 0.10, complexity_factor: 1.0, garment_types: ['knit_top'], display_order: 9, is_default: true },
  { code: 'iron', name: '熨烫', category: 'finishing', base_rate_rmb: 0.15, complexity_factor: 1.0, garment_types: ['knit_top'], display_order: 10, is_default: true },
  { code: 'trim_thread', name: '剪线头/修边', category: 'finishing', base_rate_rmb: 0.15, complexity_factor: 1.0, garment_types: ['knit_top'], display_order: 11, is_default: true },
  { code: 'qc', name: '成品检验', category: 'finishing', base_rate_rmb: 0.15, complexity_factor: 1.0, garment_types: ['knit_top'], display_order: 12, is_default: true },
  { code: 'packing', name: '折叠装袋', category: 'packing', base_rate_rmb: 0.15, complexity_factor: 1.0, garment_types: ['knit_top'], display_order: 13, is_default: true },
  // 默认 13 道工序合计 ≈ 2.65 RMB ≈ 2.6

  // 选装（连帽衫/复杂款）
  { code: 'attach_hood', name: '上帽子', category: 'sewing', base_rate_rmb: 0.80, complexity_factor: 1.0, garment_types: ['knit_top'], display_order: 20, is_default: false },
  { code: 'attach_pocket', name: '做袋 + 上袋', category: 'sewing', base_rate_rmb: 0.50, complexity_factor: 1.0, garment_types: ['knit_top'], display_order: 21, is_default: false },
  { code: 'attach_zipper', name: '上拉链', category: 'sewing', base_rate_rmb: 0.60, complexity_factor: 1.0, garment_types: ['knit_top'], display_order: 22, is_default: false },
  { code: 'print', name: '印花', category: 'finishing', base_rate_rmb: 0.80, complexity_factor: 1.0, garment_types: ['knit_top'], display_order: 23, is_default: false },
  { code: 'embroidery', name: '绣花', category: 'finishing', base_rate_rmb: 1.20, complexity_factor: 1.0, garment_types: ['knit_top'], display_order: 24, is_default: false },
];

// ════════════════════════════════════════════════
// 针织下装 — Legging 基础 ≈ 3.5 RMB，带 2 口袋 = 4.5（CEO 2026-04-09 校准）
// ════════════════════════════════════════════════

const KNIT_BOTTOM_OPS: DefaultOperationTemplate[] = [
  { code: 'cut_legs', name: '裁床（裤片）', category: 'cutting', base_rate_rmb: 0.40, complexity_factor: 1.0, garment_types: ['knit_bottom'], display_order: 1, is_default: true },
  { code: 'sew_rise', name: '合前后裆', category: 'sewing', base_rate_rmb: 0.50, complexity_factor: 1.0, garment_types: ['knit_bottom'], display_order: 2, is_default: true },
  { code: 'sew_inseam', name: '合内缝', category: 'sewing', base_rate_rmb: 0.40, complexity_factor: 1.0, garment_types: ['knit_bottom'], display_order: 3, is_default: true },
  { code: 'attach_waistband', name: '上腰头', category: 'sewing', base_rate_rmb: 0.70, complexity_factor: 1.0, garment_types: ['knit_bottom'], display_order: 4, is_default: true },
  { code: 'hem_leg', name: '裤口卷边', category: 'sewing', base_rate_rmb: 0.35, complexity_factor: 1.0, garment_types: ['knit_bottom'], display_order: 5, is_default: true },
  { code: 'attach_label', name: '钉唛/主标洗标', category: 'sewing', base_rate_rmb: 0.15, complexity_factor: 1.0, garment_types: ['knit_bottom'], display_order: 6, is_default: true },
  { code: 'iron', name: '熨烫', category: 'finishing', base_rate_rmb: 0.25, complexity_factor: 1.0, garment_types: ['knit_bottom'], display_order: 7, is_default: true },
  { code: 'trim_thread', name: '剪线头/修边', category: 'finishing', base_rate_rmb: 0.25, complexity_factor: 1.0, garment_types: ['knit_bottom'], display_order: 8, is_default: true },
  { code: 'qc', name: '成品检验', category: 'finishing', base_rate_rmb: 0.25, complexity_factor: 1.0, garment_types: ['knit_bottom'], display_order: 9, is_default: true },
  { code: 'packing', name: '折叠装袋', category: 'packing', base_rate_rmb: 0.25, complexity_factor: 1.0, garment_types: ['knit_bottom'], display_order: 10, is_default: true },
  // 默认 10 道工序合计 ≈ 3.50 RMB（无口袋）

  // 选装 — 2 个口袋 + 0.5×2 = 1.0 → 含口袋 Legging = 4.5
  { code: 'pocket', name: '做口袋（每只）', category: 'sewing', base_rate_rmb: 0.50, complexity_factor: 1.0, garment_types: ['knit_bottom'], display_order: 20, is_default: false },
  { code: 'drawstring', name: '抽绳/气眼', category: 'sewing', base_rate_rmb: 0.30, complexity_factor: 1.0, garment_types: ['knit_bottom'], display_order: 21, is_default: false },
];

// ════════════════════════════════════════════════
// 梭织长裤 — Chino 约 10-14 RMB
// ════════════════════════════════════════════════

const WOVEN_PANTS_OPS: DefaultOperationTemplate[] = [
  { code: 'cut_pattern', name: '裁床', category: 'cutting', base_rate_rmb: 0.8, complexity_factor: 1.0, garment_types: ['woven_pants', 'woven_shorts'], display_order: 1, is_default: true },
  { code: 'sew_pocket_front', name: '前袋', category: 'sewing', base_rate_rmb: 1.2, complexity_factor: 1.0, garment_types: ['woven_pants', 'woven_shorts'], display_order: 2, is_default: true },
  { code: 'sew_pocket_back', name: '后袋', category: 'sewing', base_rate_rmb: 1.0, complexity_factor: 1.0, garment_types: ['woven_pants', 'woven_shorts'], display_order: 3, is_default: true },
  { code: 'sew_rise', name: '合前后裆', category: 'sewing', base_rate_rmb: 0.8, complexity_factor: 1.0, garment_types: ['woven_pants', 'woven_shorts'], display_order: 4, is_default: true },
  { code: 'sew_side', name: '合外侧缝', category: 'sewing', base_rate_rmb: 0.7, complexity_factor: 1.0, garment_types: ['woven_pants', 'woven_shorts'], display_order: 5, is_default: true },
  { code: 'sew_inseam', name: '合内侧缝', category: 'sewing', base_rate_rmb: 0.7, complexity_factor: 1.0, garment_types: ['woven_pants', 'woven_shorts'], display_order: 6, is_default: true },
  { code: 'attach_waistband', name: '上腰头', category: 'sewing', base_rate_rmb: 1.2, complexity_factor: 1.0, garment_types: ['woven_pants', 'woven_shorts'], display_order: 7, is_default: true },
  { code: 'belt_loops', name: '打耳仔（裤襻）', category: 'sewing', base_rate_rmb: 0.6, complexity_factor: 1.0, garment_types: ['woven_pants', 'woven_shorts'], display_order: 8, is_default: true },
  { code: 'zipper', name: '上拉链', category: 'sewing', base_rate_rmb: 0.8, complexity_factor: 1.0, garment_types: ['woven_pants', 'woven_shorts'], display_order: 9, is_default: true },
  { code: 'buttonhole', name: '凤眼 + 钉扣', category: 'sewing', base_rate_rmb: 0.5, complexity_factor: 1.0, garment_types: ['woven_pants', 'woven_shorts'], display_order: 10, is_default: true },
  { code: 'hem_leg', name: '裤口卷边', category: 'sewing', base_rate_rmb: 0.5, complexity_factor: 1.0, garment_types: ['woven_pants', 'woven_shorts'], display_order: 11, is_default: true },
  { code: 'attach_label', name: '钉唛/主标洗标', category: 'sewing', base_rate_rmb: 0.3, complexity_factor: 1.0, garment_types: ['woven_pants', 'woven_shorts'], display_order: 12, is_default: true },
  { code: 'iron', name: '熨烫', category: 'finishing', base_rate_rmb: 0.5, complexity_factor: 1.0, garment_types: ['woven_pants', 'woven_shorts'], display_order: 13, is_default: true },
  { code: 'trim_thread', name: '剪线头/修边', category: 'finishing', base_rate_rmb: 0.4, complexity_factor: 1.0, garment_types: ['woven_pants', 'woven_shorts'], display_order: 14, is_default: true },
  { code: 'qc', name: '成品检验', category: 'finishing', base_rate_rmb: 0.4, complexity_factor: 1.0, garment_types: ['woven_pants', 'woven_shorts'], display_order: 15, is_default: true },
  { code: 'packing', name: '折叠装袋', category: 'packing', base_rate_rmb: 0.3, complexity_factor: 1.0, garment_types: ['woven_pants', 'woven_shorts'], display_order: 16, is_default: true },
];

export const DEFAULT_OPERATIONS: DefaultOperationTemplate[] = [
  ...KNIT_TOP_OPS,
  ...KNIT_BOTTOM_OPS,
  ...WOVEN_PANTS_OPS,
];

export function getDefaultOperationsForType(
  garmentType: GarmentType,
  includeOptional = false,
): DefaultOperationTemplate[] {
  return DEFAULT_OPERATIONS.filter(op => {
    if (!op.garment_types.includes(garmentType)) return false;
    if (!includeOptional && !op.is_default) return false;
    return true;
  }).sort((a, b) => a.display_order - b.display_order);
}
