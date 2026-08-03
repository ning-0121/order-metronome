/**
 * PO 解析数量自洽自检(2026-08-03 事故后立)。
 *
 * CEO 定性:「填写的没错误,应该是系统识别出错了。订单详情页的数量是对的,
 * 但是尺码数量明细那里 AI 填入了错误的数量。」
 *
 * 真实案例就是下面第一条:EHL PO 79042 的 31407BA,AI 自己声明 total_qty=306,
 * 却只给出黑色 184 + 酒红 92 = 276。**AI 的输出自己前后矛盾**,
 * 而当时系统没有任何一处校这个,数据就这么进库了 —— 订单头 816 件、明细 786 件。
 * 全库同类问题当时 12 张单、差额近 10 万件。
 *
 * prompt 里其实写了「自检 各尺码之和 = 该色总数量」,但那是**请求 AI 自觉**,不是保证。
 * 这里锁的是确定性代码兜底:AI 说什么不重要,数字对不上就必须报出来。
 */
import { describe, it, expect } from 'vitest';
import { checkPOQuantityConsistency } from '@/lib/domain/po-quantity-check';

describe('款级:各色之和 ≠ AI 声明的款总量', () => {
  it('EHL 79042 真实case —— 声明 306,颜色只给到 276', () => {
    const notes = checkPOQuantityConsistency([
      {
        style_no: '31407BA',
        total_qty: 306,
        colors: [
          { color_cn: '黑色', qty: 184 },
          { color_cn: '酒红色', qty: 92 },
        ],
      },
    ]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('31407BA');
    expect(notes[0]).toContain('276');
    expect(notes[0]).toContain('306');
    expect(notes[0]).toContain('差 30');
  });

  it('同一张 PO 里对得上的款不报警(31444BA:204+204+102=510)', () => {
    expect(checkPOQuantityConsistency([
      {
        style_no: '31444BA',
        total_qty: 510,
        colors: [
          { color_cn: '黑色', qty: 204 },
          { color_cn: '灰棕色', qty: 204 },
          { color_cn: '藏青色', qty: 102 },
        ],
      },
    ])).toEqual([]);
  });
});

describe('色级:各尺码之和 ≠ 该色数量', () => {
  it('尺码拆分少了会报出来', () => {
    const notes = checkPOQuantityConsistency([
      { style_no: 'A1', total_qty: 100, colors: [{ color_cn: '黑', qty: 100, sizes: { S: 30, M: 30, L: 30 } }] },
    ]);
    expect(notes.some((n) => n.includes('各尺码之和 90') && n.includes('≠ 该色数量 100'))).toBe(true);
  });

  it('没给 qty 时用尺码之和顶上,款级仍能比', () => {
    const notes = checkPOQuantityConsistency([
      { style_no: 'A1', total_qty: 120, colors: [{ color_cn: '黑', sizes: { S: 50, M: 50 } }] },
    ]);
    expect(notes).toHaveLength(1);           // 只报款级,不报色级(该色没声明 qty,无从比)
    expect(notes[0]).toContain('各色之和 100');
  });
});

describe('不制造噪音 —— 缺失 ≠ 对不上', () => {
  it('款总量为 0(没提取到)不报警', () => {
    expect(checkPOQuantityConsistency([
      { style_no: 'A1', total_qty: 0, colors: [{ color_cn: '黑', qty: 50 }] },
    ])).toEqual([]);
  });

  it('完全没有颜色数据不报警', () => {
    expect(checkPOQuantityConsistency([{ style_no: 'A1', total_qty: 500, colors: [] }])).toEqual([]);
  });

  it('尺码没提取到(sizes 空)不报色级警', () => {
    expect(checkPOQuantityConsistency([
      { style_no: 'A1', total_qty: 100, colors: [{ color_cn: '黑', qty: 100, sizes: {} }] },
    ])).toEqual([]);
  });

  it('空输入安全', () => {
    expect(checkPOQuantityConsistency(null)).toEqual([]);
    expect(checkPOQuantityConsistency(undefined)).toEqual([]);
    expect(checkPOQuantityConsistency([])).toEqual([]);
  });
});
