import { describe, it, expect } from 'vitest';
import { isSizeLabel, keepSizeLabels } from '@/lib/utils/size-sort';

/**
 * 尺码配比分摊事故(2026-08-17)。
 *
 * 现象:配比框填 S:M:L:XL = 1:2:2:1、总量 5184,摊出来是 741/1481/1481/741 ——
 * 比例看着完全正确、合计也恰好等于总量,唯独每码数量全错(应为 864/1728/1728/864)。
 *
 * 根因不在分摊算法,在**喂给它的尺码列表**:Excel/AI 解析客户订单表时把表头的数据列
 * 「QTY (PCS)」当成尺码列吸进了 sizeLabels(生产库实存 26 行 / 3 张单),
 * 于是配比多算一份 → 6 份变 7 份 → 5184 ÷ 7 = 740.57。
 *
 * 这类错极难靠肉眼发现(比例对、总量对),所以这里用**事故原始数字**锁死。
 */

/** 与 LineItemMatrixEditor.distributeByRatio 同实现(纯函数,便于独立回归)。 */
function distributeByRatio(total: number, ratio: Record<string, number> | undefined, sizes: string[]): Record<string, number> {
  if (sizes.length === 0 || total <= 0) return {};
  let r = sizes.map((s) => Math.max(0, Number(ratio?.[s]) || 0));
  if (r.reduce((a, b) => a + b, 0) === 0) r = sizes.map(() => 1);
  const sumR = r.reduce((a, b) => a + b, 0);
  const raw = r.map((x) => (total * x) / sumR);
  const floored = raw.map(Math.floor);
  const rem = total - floored.reduce((a, b) => a + b, 0);
  const byFrac = raw.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < rem && byFrac.length; k++) floored[byFrac[k % byFrac.length].i]++;
  const out: Record<string, number> = {};
  sizes.forEach((s, i) => { out[s] = floored[i]; });
  return out;
}

describe('尺码配比分摊 · 非尺码列不得参与', () => {
  const RATIO = { S: 1, M: 2, L: 2, XL: 1, 'QTY (PCS)': 1 };
  const DIRTY = ['S', 'M', 'L', 'XL', 'QTY (PCS)'];   // 生产库实际存成这样

  it('⭐ 事故复现:QTY (PCS) 混进尺码列 → 6 份变 7 份,每码全错', () => {
    const bad = distributeByRatio(5184, RATIO, DIRTY);
    expect(bad).toMatchObject({ S: 741, M: 1481, L: 1481, XL: 741 });   // 截图里的错误值
    expect(bad['QTY (PCS)']).toBe(740);                                  // 被白吃掉的一份
  });

  it('⭐ 修复后:过滤非尺码列 → 5184 ÷ 6 = 864,得 864/1728/1728/864', () => {
    const good = distributeByRatio(5184, RATIO, keepSizeLabels(DIRTY));
    expect(good).toEqual({ S: 864, M: 1728, L: 1728, XL: 864 });
    expect(Object.values(good).reduce((a, b) => a + b, 0)).toBe(5184);   // 合计仍精确等于总量
  });

  it('1:1:1:1 均分:2700 → 675 each(而非被 QTY 吃掉一份的 540)', () => {
    const sizes = keepSizeLabels(['S', 'M', 'L', 'XL', 'QTY (PCS)']);
    const got = distributeByRatio(2700, { S: 1, M: 1, L: 1, XL: 1 }, sizes);
    expect(got).toEqual({ S: 675, M: 675, L: 675, XL: 675 });
  });

  it('除不尽也要合计精确等于总量(余数按小数从大到小 +1)', () => {
    const got = distributeByRatio(1000, { S: 1, M: 2, L: 2, XL: 1 }, ['S', 'M', 'L', 'XL']);
    expect(Object.values(got).reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it('数据列一律不认', () => {
    for (const k of ['QTY (PCS)', 'qty', '小计', '总量', '箱数', 'TOTAL', 'Subtotal', '合计', '金额', '单价']) {
      expect(isSizeLabel(k), `「${k}」不该被当成尺码`).toBe(false);
    }
  });

  it('⭐ 真尺码一个都不能误杀(写法很杂,黑名单不能扩太狠)', () => {
    // 生产库里真实出现过的写法
    for (const k of ['S', 'M', 'L', 'XL', 'XS', 'XXL', '2XL', '1X', '2X', '3X', '1x', '2x', 'G', 'P', 'GG', '90', '110', '38']) {
      expect(isSizeLabel(k), `「${k}」是真尺码,不该被过滤`).toBe(true);
    }
  });

  it('空值/空白不算尺码', () => {
    expect(isSizeLabel('')).toBe(false);
    expect(isSizeLabel('   ')).toBe(false);
    expect(isSizeLabel(null)).toBe(false);
    expect(isSizeLabel(undefined)).toBe(false);
  });

  it('keepSizeLabels 保序,只剔除非尺码', () => {
    expect(keepSizeLabels(['S', 'QTY (PCS)', 'M', '小计', 'L'])).toEqual(['S', 'M', 'L']);
  });
});
