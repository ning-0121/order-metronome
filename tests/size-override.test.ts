import { describe, it, expect } from 'vitest';
import { overrideToSegments, segmentsTotal } from '@/lib/procurement/sizeOverride';

// 根因3:尺码意图(size_qty_override)→ 执行行分段 的纯派生;这是尺码 saga 的回归护栏。
describe('overrideToSegments', () => {
  it('正常 override 拆成逐码段,总量守恒', () => {
    const segs = overrideToSegments({ XS: 2300, S: 4500, M: 4500, L: 2300, XL: 2300 });
    expect(segs).toEqual([
      { size: 'XS', qty: 2300 }, { size: 'S', qty: 4500 }, { size: 'M', qty: 4500 },
      { size: 'L', qty: 2300 }, { size: 'XL', qty: 2300 },
    ]);
    expect(segmentsTotal(segs)).toBe(15900);   // 与截图里 15900 一致
  });

  it('qty<=0 / 非数字的码被剔除', () => {
    expect(overrideToSegments({ S: 10, M: 0, L: -5, XL: 'x' as any })).toEqual([{ size: 'S', qty: 10 }]);
  });

  it('字符串数字也接受', () => {
    expect(overrideToSegments({ S: '3' as any })).toEqual([{ size: 'S', qty: 3 }]);
  });

  it('空/null/数组/字符串 → 空段(不炸)', () => {
    expect(overrideToSegments(null)).toEqual([]);
    expect(overrideToSegments(undefined)).toEqual([]);
    expect(overrideToSegments({})).toEqual([]);
    expect(overrideToSegments([1, 2] as any)).toEqual([]);
    expect(overrideToSegments('S:1' as any)).toEqual([]);
  });

  it('全零 override → 空段(退回单行整量的判据)', () => {
    expect(overrideToSegments({ S: 0, M: 0 })).toEqual([]);
    expect(segmentsTotal(overrideToSegments({ S: 0 }))).toBe(0);
  });
});
