/**
 * 尺码键去重(2026-08-04 事故后立)。
 *
 * 事故:CEO 报 1022978(圣安娜)导出的生产单格式错乱 —— 表头变成
 * 「S S S S S S S S S S M M M M …」,一个尺码重复十几列。
 *
 * 根因:production-task-template.ts 把 10 个颜色行的尺码键
 * `colors.flatMap(c => Object.keys(c.sizes))` 直接传给 orderSizeKeys(10 行 × 5 码 = 50 个),
 * 而后者当时**只排序不去重** —— 排完序重复项正好挤在一起,于是 50 列。
 *
 * 修在根上(orderSizeKeys 内部去重)而不是让调用方各自记得去重:
 * 「排列尺码键」这件事本身就不该返回重复。其余 8 处调用传的都是 Set 展开、本来就唯一。
 */
import { describe, it, expect } from 'vitest';
import { orderSizeKeys } from '@/lib/utils/size-sort';

describe('orderSizeKeys 去重', () => {
  it('1022978 真实形态:10 行 × 5 码 → 5 列,不是 50 列', () => {
    const colors = Array.from({ length: 10 }, () => ({ sizes: { L: 1, M: 1, S: 1, XL: 1, XXL: 1 } }));
    const raw = colors.flatMap((c) => Object.keys(c.sizes));
    expect(raw).toHaveLength(50);                       // 调用方传进来确实是 50 个
    expect(orderSizeKeys(raw)).toEqual(['S', 'M', 'L', 'XL', 'XXL']);
  });

  it('本来就唯一的输入不受影响(其余 8 处调用都是这种)', () => {
    expect(orderSizeKeys(['XL', 'S', 'M'])).toEqual(['S', 'M', 'XL']);
  });

  it('显式码序下也去重,且保住手排顺序', () => {
    expect(orderSizeKeys(['XL', 'S', 'S', 'M', 'XL'], ['S', 'M', 'XL'])).toEqual(['S', 'M', 'XL']);
  });

  it('显式码序里没列出的码,去重后按标准序附在末尾', () => {
    const out = orderSizeKeys(['XXL', 'S', 'XXL', 'M'], ['S', 'M']);
    expect(out.slice(0, 2)).toEqual(['S', 'M']);
    expect(out).toHaveLength(3);
    expect(out).toContain('XXL');
  });

  it('空输入安全', () => {
    expect(orderSizeKeys([])).toEqual([]);
  });
});
