import { describe, it, expect } from 'vitest';
import { orderSizeKeys } from '@/lib/utils/size-sort';

/**
 * PI(形式发票)格式红线(2026-07-31,领导开始按 PI 格式考核)。
 *
 * 拿真实订单跑了一遍生成,揪出三个会直接被客户看到的问题,这里锁死。
 */

describe('PI 尺码列必须按码序,不能按 jsonb 写入顺序', () => {
  // 实测 QM-20260729-001:sizes 的 Object.keys() 出来是 L-M-S-XL,PI 就照着印了
  it('乱序键 → 标准码序', () => {
    expect(orderSizeKeys(['L', 'M', 'S', 'XL'], null).join('-')).toBe('S-M-L-XL');
  });

  it('订单自定义码序优先于标准码序', () => {
    expect(orderSizeKeys(['L', 'M', 'S', 'XL'], ['S', 'M', 'L', 'XL']).join('-')).toBe('S-M-L-XL');
    // 客户要求倒序时也照客户的来
    expect(orderSizeKeys(['S', 'XL', 'M'], ['XL', 'M', 'S']).join('-')).toBe('XL-M-S');
  });

  it('全库仅 6/201 张单存了 size_order,所以没有自定义码序时也必须能排对', () => {
    expect(orderSizeKeys(['XXL', 'XS', 'M'], undefined).join('-')).toBe('XS-M-XXL');
  });
});

/**
 * 套装单位:PI 上印 SETS 还是 PCS。
 * 原逻辑看 order_line_items.unit,但 saveOrderLineItems 把该列硬编码成 'pcs',
 * SETS 分支永远不可达 —— 10200 套被印成「10200 PCS」,客户按件理解直接差一半。
 * 正确依据是 set_multiplier(与 orderStatPieces 同口径)。
 */
function unitLabel(rows: Array<{ unit?: string | null; set_multiplier?: number | null }>): string {
  const first = rows[0] || {};
  const isSet = rows.some((l) => Number(l.set_multiplier) > 1);
  return isSet || (first.unit && !/pcs|件/i.test(first.unit)) ? 'SETS' : 'PCS';
}

describe('PI 套装单位', () => {
  it('set_multiplier>1 → SETS,即便 unit 列被硬编码成 pcs', () => {
    expect(unitLabel([{ unit: 'pcs', set_multiplier: 2 }])).toBe('SETS');
    expect(unitLabel([{ unit: '"pcs"', set_multiplier: 2 }])).toBe('SETS');
  });

  it('同款多色只要有一行是套装就整款算 SETS', () => {
    expect(unitLabel([{ unit: 'pcs', set_multiplier: 1 }, { unit: 'pcs', set_multiplier: 2 }])).toBe('SETS');
  });

  it('普通单仍是 PCS', () => {
    expect(unitLabel([{ unit: 'pcs', set_multiplier: 1 }])).toBe('PCS');
    expect(unitLabel([{ unit: 'pcs', set_multiplier: null }])).toBe('PCS');
  });
});

/**
 * 金额格:未知的箱数/单价要留空,不能印 0。
 * 正式发票上「0」是一个断言(零单价),而实际含义是「还没填」——
 * 印 0 会让客户以为报价为零。QTY 例外:是 0 说明数据坏了,应该看得见。
 */
const blank0 = (v: any) => (Number(v) > 0 ? Number(v) : '');

describe('PI 空值不印 0', () => {
  it('箱数/单价未填 → 空字符串', () => {
    expect(blank0(0)).toBe('');
    expect(blank0(null)).toBe('');
    expect(blank0(undefined)).toBe('');
  });
  it('有值照常印数字', () => {
    expect(blank0(18.97)).toBe(18.97);
    expect(blank0(120)).toBe(120);
  });
});
