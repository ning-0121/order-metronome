/**
 * 辅料自动估算 — 按品类估算标签/拉链/纽扣/包材的单件成本
 *
 * CEO 2026-04-09：辅料要自动分析每件产品用多少
 *
 * 经验值基于傲狐实际数据，后续可以通过训练数据校准。
 */

import type { GarmentType } from '../types';

export interface TrimEstimate {
  category: string;
  item: string;
  qtyPerPiece: number;
  unitPrice: number;
  costPerPiece: number;
  unit: string;
}

export interface TrimEstimateResult {
  items: TrimEstimate[];
  totalPerPiece: number;
  reasoning: string;
}

/**
 * 按品类估算辅料成本
 */
export function estimateTrims(
  garmentType: GarmentType,
  options?: {
    hasZipper?: boolean;
    hasButton?: boolean;
    hasPocket?: boolean;
    hasDrawstring?: boolean;
    hasReflective?: boolean;
    packingType?: 'polybag' | 'hanger' | 'box';
  },
): TrimEstimateResult {
  const items: TrimEstimate[] = [];
  const opts = options || {};

  // 通用辅料（所有品类都有）
  items.push({ category: '标签', item: '主标（织标）', qtyPerPiece: 1, unitPrice: 0.15, costPerPiece: 0.15, unit: '个' });
  items.push({ category: '标签', item: '洗标/成分标', qtyPerPiece: 1, unitPrice: 0.10, costPerPiece: 0.10, unit: '个' });
  items.push({ category: '标签', item: '吊牌', qtyPerPiece: 1, unitPrice: 0.20, costPerPiece: 0.20, unit: '套' });
  items.push({ category: '线', item: '缝纫线', qtyPerPiece: 1, unitPrice: 0.05, costPerPiece: 0.05, unit: '份' });

  // 品类特定
  switch (garmentType) {
    case 'knit_top':
      items.push({ category: '领', item: '领标/尺码标', qtyPerPiece: 1, unitPrice: 0.08, costPerPiece: 0.08, unit: '个' });
      if (opts.hasZipper) {
        items.push({ category: '拉链', item: '前开拉链', qtyPerPiece: 1, unitPrice: 0.80, costPerPiece: 0.80, unit: '条' });
      }
      break;

    case 'knit_bottom':
      items.push({ category: '腰头', item: '腰头松紧带', qtyPerPiece: 1, unitPrice: 0.30, costPerPiece: 0.30, unit: '条' });
      items.push({ category: '腰头', item: '腰卡', qtyPerPiece: 1, unitPrice: 0.10, costPerPiece: 0.10, unit: '个' });
      if (opts.hasDrawstring) {
        items.push({ category: '腰头', item: '抽绳', qtyPerPiece: 1, unitPrice: 0.15, costPerPiece: 0.15, unit: '条' });
      }
      break;

    case 'woven_pants':
    case 'woven_shorts':
      items.push({ category: '腰头', item: '腰头衬布', qtyPerPiece: 1, unitPrice: 0.20, costPerPiece: 0.20, unit: '条' });
      items.push({ category: '拉链', item: '门襟拉链', qtyPerPiece: 1, unitPrice: 0.40, costPerPiece: 0.40, unit: '条' });
      items.push({ category: '纽扣', item: '腰扣', qtyPerPiece: 1, unitPrice: 0.15, costPerPiece: 0.15, unit: '个' });
      items.push({ category: '辅料', item: '裤襻（belt loop）', qtyPerPiece: 5, unitPrice: 0.03, costPerPiece: 0.15, unit: '条' });
      break;
  }

  // 包装
  const packType = opts.packingType || 'polybag';
  if (packType === 'polybag') {
    items.push({ category: '包装', item: 'OPP 自封袋', qtyPerPiece: 1, unitPrice: 0.08, costPerPiece: 0.08, unit: '个' });
  } else if (packType === 'hanger') {
    items.push({ category: '包装', item: '衣架 + 挂钩袋', qtyPerPiece: 1, unitPrice: 0.35, costPerPiece: 0.35, unit: '套' });
  } else {
    items.push({ category: '包装', item: '单件包装盒', qtyPerPiece: 1, unitPrice: 0.60, costPerPiece: 0.60, unit: '个' });
  }
  items.push({ category: '包装', item: '纸箱分摊', qtyPerPiece: 1, unitPrice: 0.15, costPerPiece: 0.15, unit: '份' });

  const totalPerPiece = Number(items.reduce((s, i) => s + i.costPerPiece, 0).toFixed(2));

  const reasoning = [
    `品类：${garmentType}`,
    `辅料项：${items.length} 种`,
    `${opts.hasZipper ? '含拉链' : ''}${opts.hasDrawstring ? '含抽绳' : ''}${opts.hasButton ? '含纽扣' : ''}`.trim() || '标准配置',
    `包装方式：${packType === 'polybag' ? 'OPP袋' : packType === 'hanger' ? '衣架' : '盒装'}`,
    `辅料总计：¥${totalPerPiece}/件`,
  ].filter(Boolean).join(' · ');

  return { items, totalPerPiece, reasoning };
}
