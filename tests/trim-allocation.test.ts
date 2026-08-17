/**
 * Trim SKU Allocation —— 用两张**真实生产订单**做基准。
 *
 * 数字来自业务手工做的那张《采购申请单》Excel(2026-08-16 摩擦证据 #2),
 * 以及生产库 order_line_items 的实测值(两者逐格一致):
 *   QM-20260812-006 / PO 79147 / 款 31453R:S368 M736 L736 XL368 = 2208
 *   QM-20260812-002 / PO 79146 / 款 31456R:S300 M600 L600 XL300 = 1800
 *   吊卡 / 洗标 = 2208 + 1800 = 4008
 *
 * 这 9 个数字是 P0 验收线:必须由系统算出来,跟单一个都不许手抄。
 */
import { describe, it, expect } from 'vitest';
import {
  allocateTrim,
  allocationWeights,
  normalizeAllocationMode,
  totalFromMatrix,
  type StyleMatrixCell,
} from '@/lib/procurement/trimAllocation';
import { distributeByWeights } from '@/lib/services/procurement-execution';

/** 31453R:S368 M736 L736 XL368(非套装,件/套=1) */
const M_31453R: StyleMatrixCell[] = [
  { styleNo: '31453R', productName: 'JRS PLUSHMERE OFF THE SHOULDER', colorCn: '奶白', colorEn: 'CREAM', size: 'S', commercialQty: 368, setMultiplier: 1 },
  { styleNo: '31453R', productName: 'JRS PLUSHMERE OFF THE SHOULDER', colorCn: '奶白', colorEn: 'CREAM', size: 'M', commercialQty: 736, setMultiplier: 1 },
  { styleNo: '31453R', productName: 'JRS PLUSHMERE OFF THE SHOULDER', colorCn: '奶白', colorEn: 'CREAM', size: 'L', commercialQty: 736, setMultiplier: 1 },
  { styleNo: '31453R', productName: 'JRS PLUSHMERE OFF THE SHOULDER', colorCn: '奶白', colorEn: 'CREAM', size: 'XL', commercialQty: 368, setMultiplier: 1 },
];

/** 31456R:S300 M600 L600 XL300 */
const M_31456R: StyleMatrixCell[] = [
  { styleNo: '31456R', productName: 'JRS PLUSHMERE HOODED V NECK', colorCn: '奶白', colorEn: 'CREAM', size: 'S', commercialQty: 300, setMultiplier: 1 },
  { styleNo: '31456R', productName: 'JRS PLUSHMERE HOODED V NECK', colorCn: '奶白', colorEn: 'CREAM', size: 'M', commercialQty: 600, setMultiplier: 1 },
  { styleNo: '31456R', productName: 'JRS PLUSHMERE HOODED V NECK', colorCn: '奶白', colorEn: 'CREAM', size: 'L', commercialQty: 600, setMultiplier: 1 },
  { styleNo: '31456R', productName: 'JRS PLUSHMERE HOODED V NECK', colorCn: '奶白', colorEn: 'CREAM', size: 'XL', commercialQty: 300, setMultiplier: 1 },
];

const BOTH = [...M_31453R, ...M_31456R];

const bySize = (cells: Array<{ size: string; qty: number }>) =>
  Object.fromEntries(cells.map((c) => [c.size, c.qty]));

describe('验收 1/2:尺码牌按款×色×码自动分配', () => {
  it('31453R 尺码牌复现 S368/M736/L736/XL368,合计 2208', () => {
    const r = allocateTrim({
      mode: 'by_style_color_size',
      styleNo: '31453R',
      qtyPerPiece: 1,
      consumptionBasis: 'PER_SET',
      matrix: BOTH,
    });
    expect(r.status).toBe('OK');
    expect(bySize(r.cells)).toEqual({ S: 368, M: 736, L: 736, XL: 368 });
    expect(r.total).toBe(2208);
  });

  it('31456R 尺码牌复现 S300/M600/L600/XL300,合计 1800', () => {
    const r = allocateTrim({
      mode: 'by_style_color_size',
      styleNo: '31456R',
      qtyPerPiece: 1,
      consumptionBasis: 'PER_SET',
      matrix: BOTH,
    });
    expect(r.status).toBe('OK');
    expect(bySize(r.cells)).toEqual({ S: 300, M: 600, L: 600, XL: 300 });
    expect(r.total).toBe(1800);
  });

  it('BOM 行限定款号 → 只分配该款,不串到另一款', () => {
    const r = allocateTrim({
      mode: 'by_style_color_size', styleNo: '31453R',
      qtyPerPiece: 1, consumptionBasis: 'PER_SET', matrix: BOTH,
    });
    expect(r.cells.every((c) => c.style_no === '31453R')).toBe(true);
  });
});

describe('验收 3:吊卡/洗标整单量由两款求和自动得出', () => {
  it('整单通用吊卡(不限款)→ 4008', () => {
    expect(totalFromMatrix({ qtyPerPiece: 1, consumptionBasis: 'PER_SET', matrix: BOTH })).toBe(4008);
  });

  it('洗标 2 个/套 → 8016(倍数照样是算出来的,不是抄的)', () => {
    expect(totalFromMatrix({ qtyPerPiece: 2, consumptionBasis: 'PER_SET', matrix: BOTH })).toBe(8016);
  });

  it('整单通用但按码分 → 两款的码合并统计,总量仍是 4008', () => {
    const r = allocateTrim({ mode: 'by_style_color_size', qtyPerPiece: 1, consumptionBasis: 'PER_SET', matrix: BOTH });
    expect(r.status).toBe('OK');
    expect(r.total).toBe(4008);
    expect(r.cells).toHaveLength(8);   // 两款 × 四码,不跨款合并
  });
});

describe('口径绝不猜(证据 #1 的教训:猜错差一倍)', () => {
  it('consumption_basis 未确认 → NEEDS_BASIS,不产出任何数量', () => {
    for (const basis of [null, '', undefined, 'GUESS_ME']) {
      const r = allocateTrim({ mode: 'by_style_color_size', qtyPerPiece: 1, consumptionBasis: basis as any, matrix: BOTH });
      expect(r.status).toBe('NEEDS_BASIS');
      expect(r.cells).toHaveLength(0);
      expect(r.total).toBe(0);
    }
  });

  it('整单固定 / 计量类口径 → NOT_ALLOCATABLE,不硬拆', () => {
    for (const basis of ['PER_ORDER', 'MANUAL_TOTAL', 'PER_KG', 'PER_METER']) {
      const r = allocateTrim({ mode: 'by_style_color_size', qtyPerPiece: 1, consumptionBasis: basis, matrix: BOTH });
      expect(r.status).toBe('NOT_ALLOCATABLE');
      expect(r.cells).toHaveLength(0);
    }
  });

  it('单耗为空 → NEEDS_CONSUMPTION,不按 1 兜底', () => {
    const r = allocateTrim({ mode: 'by_style_color_size', qtyPerPiece: null, consumptionBasis: 'PER_SET', matrix: BOTH });
    expect(r.status).toBe('NEEDS_CONSUMPTION');
  });
});

describe('套数 vs 件数(本项目栽过跟头的地方)', () => {
  /** 套装:每套 2 件,尺码格里录的是套数 */
  const SET_MATRIX: StyleMatrixCell[] = [
    { styleNo: 'SET01', productName: '两件套', colorCn: '黑', colorEn: 'BLACK', size: 'M', commercialQty: 480, setMultiplier: 2 },
  ];

  it('PER_SET → 按套数 480,不乘件/套', () => {
    const r = allocateTrim({ mode: 'by_style_color_size', qtyPerPiece: 1, consumptionBasis: 'PER_SET', matrix: SET_MATRIX });
    expect(r.total).toBe(480);
  });

  it('PER_PIECE → 按件数 960,乘件/套', () => {
    const r = allocateTrim({ mode: 'by_style_color_size', qtyPerPiece: 1, consumptionBasis: 'PER_PIECE', matrix: SET_MATRIX });
    expect(r.total).toBe(960);
  });

  it('PER_COMPONENT 同件数口径', () => {
    const r = allocateTrim({ mode: 'by_style_color_size', qtyPerPiece: 1, consumptionBasis: 'PER_COMPONENT', matrix: SET_MATRIX });
    expect(r.total).toBe(960);
  });
});

describe('分配粒度与降级', () => {
  it('by_style:两款各一格,不分色不分码', () => {
    const r = allocateTrim({ mode: 'by_style', qtyPerPiece: 1, consumptionBasis: 'PER_SET', matrix: BOTH });
    expect(r.status).toBe('OK');
    expect(r.cells).toHaveLength(2);
    expect(r.cells.every((c) => c.size === '')).toBe(true);
    expect(r.total).toBe(4008);
  });

  it('by_style_color:同款同色合成一格', () => {
    const r = allocateTrim({ mode: 'by_style_color', qtyPerPiece: 1, consumptionBasis: 'PER_SET', matrix: BOTH });
    expect(r.cells).toHaveLength(2);
    expect(r.total).toBe(4008);
  });

  it('whole_order → 不分配,走老路径', () => {
    const r = allocateTrim({ mode: 'whole_order', qtyPerPiece: 1, consumptionBasis: 'PER_SET', matrix: BOTH });
    expect(r.status).toBe('WHOLE_ORDER');
    expect(r.cells).toHaveLength(0);
  });

  it('按码分配但订单没录尺码 → NO_MATRIX,明确交回跟单,不静默出 0', () => {
    const noSize: StyleMatrixCell[] = [
      { styleNo: 'A', productName: '', colorCn: '黑', colorEn: '', size: null, commercialQty: 100, setMultiplier: 1 },
    ];
    const r = allocateTrim({ mode: 'by_style_color_size', qtyPerPiece: 1, consumptionBasis: 'PER_SET', matrix: noSize });
    expect(r.status).toBe('NO_MATRIX');
    expect(r.message).toContain('尺码');
  });

  it('订单矩阵为空 → NO_MATRIX', () => {
    const r = allocateTrim({ mode: 'by_style_color_size', qtyPerPiece: 1, consumptionBasis: 'PER_SET', matrix: [] });
    expect(r.status).toBe('NO_MATRIX');
  });
});

describe('老数据零影响', () => {
  it('allocation_mode 为 NULL/脏值 → whole_order(在途订单行为不变)', () => {
    for (const v of [null, undefined, '', 'garbage', 123]) {
      expect(normalizeAllocationMode(v)).toBe('whole_order');
    }
  });

  it('四个合法值原样保留', () => {
    for (const v of ['whole_order', 'by_style', 'by_style_color', 'by_style_color_size']) {
      expect(normalizeAllocationMode(v)).toBe(v);
    }
  });
});

describe('取整:宁多勿缺', () => {
  it('非整数单耗向上取整并标记 rounded', () => {
    const r = allocateTrim({
      mode: 'by_style_color_size', styleNo: '31453R',
      qtyPerPiece: 1.5, consumptionBasis: 'PER_SET', matrix: M_31453R,
    });
    expect(r.status).toBe('OK');
    expect(r.rounded).toBe(false);          // 368×1.5=552 恰好整数
    expect(bySize(r.cells)).toEqual({ S: 552, M: 1104, L: 1104, XL: 552 });
  });

  it('除不尽时向上取整,不少买', () => {
    const one: StyleMatrixCell[] = [
      { styleNo: 'A', productName: '', colorCn: '黑', colorEn: '', size: 'M', commercialQty: 7, setMultiplier: 1 },
    ];
    const r = allocateTrim({ mode: 'by_style_color_size', qtyPerPiece: 1.5, consumptionBasis: 'PER_SET', matrix: one });
    expect(r.cells[0].qty).toBe(11);        // 10.5 → 11
    expect(r.rounded).toBe(true);
  });
});

describe('归并落库口径:Σ格 恒等于权威需求量(不产生第二套 Requirement Truth)', () => {
  /** 复刻 consolidate 的做法:权重来自矩阵,总量来自 material_requirements。 */
  const distribute = (total: number, matrix: StyleMatrixCell[], basis = 'PER_SET', styleNo?: string) => {
    const w = allocationWeights({ mode: 'by_style_color_size', styleNo: styleNo ?? null, color: null, consumptionBasis: basis, matrix });
    expect(w.status).toBe('OK');
    const dist = distributeByWeights(total, w.weights.map((x, i) => ({ key: i, weight: x.weight })));
    return dist.map((d) => ({ ...w.weights[d.key], qty: d.qty }));
  };

  it('权威总量 2208 分下去,逐格恰好 S368/M736/L736/XL368', () => {
    const cells = distribute(2208, M_31453R);
    expect(bySize(cells as any)).toEqual({ S: 368, M: 736, L: 736, XL: 368 });
    expect(cells.reduce((a, c) => a + c.qty, 0)).toBe(2208);
  });

  it('权威总量 1800 分下去,逐格恰好 S300/M600/L600/XL300', () => {
    const cells = distribute(1800, M_31456R);
    expect(bySize(cells as any)).toEqual({ S: 300, M: 600, L: 600, XL: 300 });
    expect(cells.reduce((a, c) => a + c.qty, 0)).toBe(1800);
  });

  it('需求量含损耗/抛量时(非整除)Σ格仍恒等于权威量 —— 不多不少', () => {
    for (const total of [2274, 2300, 2429, 3000, 4008, 8016]) {
      const cells = distribute(total, M_31453R);
      expect(cells.reduce((a, c) => a + c.qty, 0)).toBe(total);
    }
  });

  it('整单通用辅料按两款八格分,Σ 仍等于权威量', () => {
    for (const total of [4008, 8016, 4100]) {
      const cells = distribute(total, BOTH);
      expect(cells).toHaveLength(8);
      expect(cells.reduce((a, c) => a + c.qty, 0)).toBe(total);
    }
  });
});
