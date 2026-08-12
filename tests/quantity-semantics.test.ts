/**
 * 数量语义回归锁(2026-08-12 Quantity Semantics Hotfix,1022977 事故)。
 *
 * 事故:采购核料把 qty_pcs(商业套数)当物理件数用,少乘 set_multiplier;
 * 下游换算引擎又按套装单除一次 → 面料基准差一倍,直接影响采购金额与下料。
 *
 * 全库只读盘点结论(60 单有效样本):
 *   orders.quantity = **physical pieces**(套装单 10/10 命中 physical,0 命中 commercial)
 *   quantity_unit('套')= 套装标记,**不是** quantity 的计量单位
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  getCommercialQty, getPhysicalPieceQty, sumCommercialQty, sumPhysicalPieceQty,
  setMultiplierOf, groupPhysicalPieceQty, groupCommercialQty,
} from '@/lib/domain/line-item-quantity';
import { deriveOrderQuantityContext, formatQuantityDisplay } from '@/lib/domain/quantity-engine';

// 1022977 真实数据:S1301 两色,qty_pcs 为套数,件/套=2
const ORDER_1022977 = [
  { style_no: 'S1301', color_cn: 'BALLERINA PINK/SUGAR SWIZZLE', color_en: null, qty_pcs: 3600, set_multiplier: 2 },
  { style_no: 'S1301', color_cn: 'LEAFLESS', color_en: null, qty_pcs: 6600, set_multiplier: 2 },
];

describe('两层语义:commercial vs physical', () => {
  it('商业数量 = qty_pcs 原值(套数)', () => {
    expect(getCommercialQty(ORDER_1022977[0])).toBe(3600);
    expect(sumCommercialQty(ORDER_1022977)).toBe(10200);
  });

  it('物理件数 = qty_pcs × set_multiplier', () => {
    expect(getPhysicalPieceQty(ORDER_1022977[0])).toBe(7200);
    expect(getPhysicalPieceQty(ORDER_1022977[1])).toBe(13200);
    expect(sumPhysicalPieceQty(ORDER_1022977)).toBe(20400);
  });

  it('⭐ 1022977 验收:10200 套 / 2件套 → commercial 10200、physical 20400', () => {
    expect(sumCommercialQty(ORDER_1022977)).toBe(10200);
    expect(sumPhysicalPieceQty(ORDER_1022977)).toBe(20400);
  });

  it('非套装单(倍率缺失/1)两者相等', () => {
    const plain = [{ qty_pcs: 5850, set_multiplier: 1 }, { qty_pcs: 100, set_multiplier: null }];
    expect(sumCommercialQty(plain)).toBe(5950);
    expect(sumPhysicalPieceQty(plain)).toBe(5950);
  });

  it('倍率非法(0/负/NaN)一律按 1,绝不放大或归零', () => {
    for (const m of [0, -2, null, undefined, 'abc' as any]) {
      expect(setMultiplierOf({ qty_pcs: 100, set_multiplier: m })).toBe(1);
      expect(getPhysicalPieceQty({ qty_pcs: 100, set_multiplier: m })).toBe(100);
    }
  });

  it('空/脏数据安全', () => {
    expect(getCommercialQty(null)).toBe(0);
    expect(getPhysicalPieceQty(undefined)).toBe(0);
    expect(sumPhysicalPieceQty(null)).toBe(0);
  });
});

describe('分组汇总(算料/采购基准口径)', () => {
  it('⭐ 款×色 物理件数:7200 / 13200(修复前是 3600 / 6600)', () => {
    const { byStyle, byStyleColor } = groupPhysicalPieceQty(ORDER_1022977);
    expect(byStyleColor.get('s1301¦ballerina pink/sugar swizzle')).toBe(7200);
    expect(byStyleColor.get('s1301¦leafless')).toBe(13200);
    expect(byStyle.get('s1301')).toBe(20400);
  });

  it('同款×色多行必须累加,不得覆盖(客户加单场景)', () => {
    const dup = [
      { style_no: 'A', color_cn: '红', qty_pcs: 100, set_multiplier: 2 },
      { style_no: 'A', color_cn: '红', qty_pcs: 50, set_multiplier: 2 },
    ];
    expect(groupPhysicalPieceQty(dup).byStyleColor.get('a¦红')).toBe(300);
    expect(groupCommercialQty(dup).byStyleColor.get('a¦红')).toBe(150);
  });

  it('color_cn / color_en 两种写法都能命中', () => {
    const g = groupPhysicalPieceQty([{ style_no: 'A', color_cn: '黑', color_en: 'BLACK', qty_pcs: 10, set_multiplier: 2 }]);
    expect(g.byStyleColor.get('a¦黑')).toBe(20);
    expect(g.byStyleColor.get('a¦black')).toBe(20);
  });

  it('⭐ 中英色名相同时**不得**重复累加(bom.ts 2026-07-04 修过的翻倍 bug,不许回潮)', () => {
    const g = groupPhysicalPieceQty([{ style_no: 'A', color_cn: 'BLACK', color_en: 'BLACK', qty_pcs: 100, set_multiplier: 2 }]);
    expect(g.byStyleColor.get('a¦black')).toBe(200);   // 不是 400
    expect(groupCommercialQty([{ style_no: 'A', color_cn: 'BLACK', color_en: 'black', qty_pcs: 100 }])
      .byStyleColor.get('a¦black')).toBe(100);          // 大小写不同也算同一个色
  });
});

describe('与换算引擎串联:页面显示仍是「套(折合件)」', () => {
  it('⭐ 传物理件数 7200 + 套装单 → 显示「3600套（折合7200件）」', () => {
    const ctx = deriveOrderQuantityContext({ physicalQuantity: 7200, quantityUnit: '套' });
    const display = formatQuantityDisplay(ctx);
    expect(display).toContain('3600');
    expect(display).toContain('7200');
    expect(display).not.toContain('1800');   // 修复前的错值
  });

  it('修复前的写法(传商业套数 3600)会显示错误的 1800 —— 锁死不许回潮', () => {
    const wrong = formatQuantityDisplay(deriveOrderQuantityContext({ physicalQuantity: 3600, quantityUnit: '套' }));
    expect(wrong).toContain('1800');         // 证明少乘一次就会错一半
  });
});

describe('数量修正(correctOrderQuantity)基数必须是物理件数', () => {
  const src = readFileSync('app/actions/order-quantity-correction.ts', 'utf-8');

  it('⭐ currentTotal 用 sumPhysicalPieceQty,不得用裸 Σqty_pcs', () => {
    expect(src).toContain('sumPhysicalPieceQty(li)');
    expect(src).not.toMatch(/currentTotal\s*=\s*li\.reduce/);
  });

  it('select 带 set_multiplier(否则物理件数算不出来)', () => {
    expect(src).toMatch(/\.select\('[^']*set_multiplier[^']*'\)/);
  });

  it('场景锁:UI 填「新总件数」=当前物理件数 → ratio 必须为 1(修复前会翻倍)', () => {
    // 1022977:commercial 10200、physical 20400。用户原样填 20400 确认
    const currentPhysical = sumPhysicalPieceQty(ORDER_1022977);   // 20400
    const currentCommercialWrong = sumCommercialQty(ORDER_1022977); // 10200(修复前的错基数)
    expect(20400 / currentPhysical).toBe(1);            // 修复后:不变
    expect(20400 / currentCommercialWrong).toBe(2);     // 修复前:明细全部 ×2,订单静默变 40800
  });
});

describe('CONFIRMED 收口 ①:finance/order-snapshot 契约显式化', () => {
  const src = readFileSync('app/api/contract/v1/finance/order-snapshot/[id]/route.ts', 'utf-8');

  it('明细取 set_multiplier', () => {
    expect(src).toMatch(/\.select\('[^']*set_multiplier[^']*'\)/);
  });

  it('非破坏:保留旧 qty / quantity 字段', () => {
    expect(src).toContain('qty: l.qty_pcs');
    expect(src).toContain('quantity: o.quantity');
  });

  it('新增四个显式语义字段', () => {
    for (const f of ['commercial_quantity', 'physical_quantity', 'set_multiplier',
                     "unit_price_basis: 'commercial_unit'", "quantity_basis: 'physical_pieces'"]) {
      expect(src, `缺 ${f}`).toContain(f);
    }
  });

  it('明确 total_amount 口径公式', () => {
    expect(src).toContain("total_amount_formula: 'unit_price * commercial_quantity'");
  });
});

describe('CONFIRMED 收口 ①b:推送财务用真实倍率而非 quantity_unit 猜测', () => {
  const src = readFileSync('lib/integration/finance-sync.ts', 'utf-8');
  it('优先用明细 sumCommercialQty,无明细才回退字符串猜测', () => {
    expect(src).toContain('sumCommercialQty');
    expect(src).toContain("qtyBasisSource");
    expect(src).toContain("'line_items'");
  });
  it('payload 标注数量来源与单价口径,便于财务侧核对', () => {
    expect(src).toContain('quantity_basis_source');
    expect(src).toContain("unit_price_basis: 'commercial_unit'");
  });
});

describe('CONFIRMED 收口 ②:排产卡片总量与款色明细同口径', () => {
  const src = readFileSync('app/actions/production-scheduling.ts', 'utf-8');
  it('款色明细用 physical,并另存 commercial 供套装展示', () => {
    expect(src).toContain('getPhysicalPieceQty(l)');
    expect(src).toContain('qtyCommercial');
    expect(src).not.toMatch(/s\.qty \+= Number\(l\.qty_pcs\)/);
  });
  it('select 带 set_multiplier', () => {
    expect(src).toMatch(/\.select\('order_id, style_no[^']*set_multiplier[^']*'\)/);
  });
  it('1022977 口径:physical 20400 / commercial 10200 / 分款 7200+13200', () => {
    expect(sumPhysicalPieceQty(ORDER_1022977)).toBe(20400);
    expect(sumCommercialQty(ORDER_1022977)).toBe(10200);
    expect(getPhysicalPieceQty(ORDER_1022977[0])).toBe(7200);
    expect(getPhysicalPieceQty(ORDER_1022977[1])).toBe(13200);
  });
});

describe('CONFIRMED 收口 ③:加单继承真实倍率,不确定则显式失败', () => {
  const src = readFileSync('app/actions/order-amendments.ts', 'utf-8');
  it('不得再硬编码 set_multiplier: 1', () => {
    expect(src).not.toMatch(/sizes,\s*unit:\s*'pcs',\s*set_multiplier:\s*1/);
    expect(src).toContain('set_multiplier: mul');
  });
  it('有 resolveMultiplier 且 null 时返回 error(不静默 fallback)', () => {
    expect(src).toContain('resolveMultiplier');
    expect(src).toContain('无法确定件/套倍率');
    expect(src).toContain('系统不会替你猜倍率');
  });
  it('读取母单现有倍率作为继承来源', () => {
    expect(src).toMatch(/\.select\('style_no, set_multiplier'\)/);
  });
});

describe('调用点已迁入统一入口(防回潮)', () => {
  const files = [
    'app/actions/procurement-items.ts',
    'app/actions/procurement-cost.ts',
    'app/actions/quote-baseline.ts',
    'app/actions/bom.ts',
  ];
  for (const f of files) {
    it(`${f} 取明细数量时带上 set_multiplier`, () => {
      const src = readFileSync(f, 'utf-8');
      const selects = src.match(/\.select\('[^']*qty_pcs[^']*'\)/g) || [];
      for (const s of selects) {
        expect(s, `${f} 的 ${s} 缺 set_multiplier`).toContain('set_multiplier');
      }
    });
  }

  for (const f of ['app/actions/procurement-items.ts', 'app/actions/procurement-cost.ts', 'app/actions/quote-baseline.ts']) {
    it(`${f} 使用统一 helper 而非裸算`, () => {
      const src = readFileSync(f, 'utf-8');
      expect(src).toContain('groupPhysicalPieceQty');
    });
  }
});
