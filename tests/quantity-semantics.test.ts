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
import { deriveOrderQuantityContext, deriveQuantityContext, formatQuantityDisplay } from '@/lib/domain/quantity-engine';

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

describe('HEADER_RECONCILIATION:订单头向明细对齐(1022982 暴露的自愈缺口)', () => {
  const src = readFileSync('app/actions/order-quantity-correction.ts', 'utf-8');

  it('触发条件:明细物理数 == 请求数 且 订单头 != 请求数', () => {
    expect(src).toContain('newTotal === currentTotal && Number.isFinite(headerQty) && headerQty !== newTotal');
    expect(src).toContain('reconcileHeaderToLineItems');
  });

  it('⭐ 绝不修改 line_items(该分支内无任何 order_line_items 写操作)', () => {
    const fn = src.slice(src.indexOf('async function reconcileHeaderToLineItems'));
    expect(fn).not.toMatch(/from\('order_line_items'\)[\s\S]{0,80}\.update/);
    expect(fn).toContain('line_items_untouched: true');
  });

  it('⭐ 金额按【商业数量 × 每套单价】,不得用 quantity × unit_price(防套装从此入口回潮)', () => {
    const fn = src.slice(src.indexOf('async function reconcileHeaderToLineItems'));
    expect(fn).toContain('sumCommercialQty');
    expect(fn).toContain('unitPrice * commercialTotal');
    expect(fn).not.toMatch(/unitPrice \* physicalTotal|physicalTotal \* unitPrice/);
  });

  it('走 safeCriticalMutation(before 快照 + 写断言 + 写后回读)', () => {
    const fn = src.slice(src.indexOf('async function reconcileHeaderToLineItems'));
    expect(fn).toContain('safeCriticalMutation');
    expect(fn).toContain('verifyFields: patch');
    expect(fn).toContain("riskLevel: 'money'");
  });

  it('写明确审计事件名 + before/after', () => {
    expect(src).toContain("eventType: 'quantity_header_reconciled_from_line_items'");
    const fn = src.slice(src.indexOf('async function reconcileHeaderToLineItems'));
    expect(fn).toContain('beforeState: { quantity: headerQty');
    expect(fn).toContain('afterState: { quantity: physicalTotal');
  });

  it('主写失败即返回,不产生部分成功(副作用在写验证之后)', () => {
    const fn = src.slice(src.indexOf('async function reconcileHeaderToLineItems'));
    const failIdx = fn.indexOf('订单头对齐失败');
    const sideIdx = fn.indexOf('submitBomToProcurement');
    expect(failIdx).toBeGreaterThan(-1);
    expect(sideIdx).toBeGreaterThan(failIdx);   // 副作用必须在失败返回之后
  });

  it('头对齐不新增采购(数量并未真的增加),只 refresh', () => {
    const fn = src.slice(src.indexOf('async function reconcileHeaderToLineItems'));
    expect(fn).toContain('create: false, refresh: true');
  });

  it('1022982 场景数值:明细 960(mul=1)→ 头 1320 应对齐为 960,金额 4.4×960=4224', () => {
    const lines1022982 = [
      { qty_pcs: 600, set_multiplier: 1 },
      { qty_pcs: 360, set_multiplier: 1 },
    ];
    expect(sumPhysicalPieceQty(lines1022982)).toBe(960);
    expect(sumCommercialQty(lines1022982)).toBe(960);       // 非套装:两者相同
    expect(Math.round(4.4 * sumCommercialQty(lines1022982) * 100) / 100).toBe(4224);
  });

  it('套装场景不回潮:明细 10200 套×2 → 头对齐 20400 件,金额按 10200 套算', () => {
    expect(sumPhysicalPieceQty(ORDER_1022977)).toBe(20400);  // 写进 orders.quantity
    expect(sumCommercialQty(ORDER_1022977)).toBe(10200);     // 用于算金额
    expect(Math.round(62.28 * sumCommercialQty(ORDER_1022977) * 100) / 100).toBe(635256);
  });
});

describe('⭐ 单耗是「每套」口径 —— 算料基准必须是套数(1022977 翻倍事故)', () => {
  // 1022967 实证:同一面料、两个款,单耗随套内件数放大 ⇒ 单耗已含套内所有件
  const SP1581B = { qty_pcs: 2400, set_multiplier: 1, cons: 0.6 };    // 1 件/套
  const SP1770 = { qty_pcs: 2400, set_multiplier: 2, cons: 1.215 };   // 2 件/套

  it('判据:单耗之比 ≈ 倍率之比 ⇒ 单耗按每套', () => {
    const consRatio = SP1770.cons / SP1581B.cons;      // 2.025
    const mulRatio = SP1770.set_multiplier / SP1581B.set_multiplier;  // 2
    expect(Math.abs(consRatio - mulRatio)).toBeLessThan(0.15);
  });

  it('1022977:面料需求 = 单耗 × 套数 = 8976kg(不是 × 件数的 17952kg)', () => {
    const lines = [{ qty_pcs: 3600, set_multiplier: 2 }, { qty_pcs: 6600, set_multiplier: 2 }];
    const commercial = sumCommercialQty(lines);   // 10200 套
    const physical = sumPhysicalPieceQty(lines);  // 20400 件
    expect(0.88 * commercial).toBe(8976);          // ✅ 正确
    expect(0.88 * physical).toBe(17952);           // ❌ 翻倍(2026-08-12 误改造成)
  });

  it('1022967:两款分别 1440kg / 2916kg,合计 4356kg', () => {
    expect(SP1581B.cons * SP1581B.qty_pcs).toBe(1440);
    expect(Math.round(SP1770.cons * SP1770.qty_pcs)).toBe(2916);
  });
});

describe('⭐ 显示层用真实倍率,不用 quantity_unit 字符串(1022967 混合倍率)', () => {
  const src = readFileSync('app/actions/procurement-items.ts', 'utf-8');

  it('传 componentsPerCommercialUnit(优先级高于单位字符串)', () => {
    expect(src).toContain('componentsPerCommercialUnit: mul');
    expect(src).toContain('mulOf(b)');
  });

  it('混合倍率单不得被订单级单位统一换算', () => {
    // 1022967 标「三件套」但实际 mul 是 2 和 1 —— 统一 ÷3 会显示成荒谬的「800三件套」
    expect(deriveQuantityContext({ physicalQuantity: 2400, componentsPerCommercialUnit: 1, quantityUnit: '件' }).commercialQuantity).toBe(2400);
    expect(deriveQuantityContext({ physicalQuantity: 4800, componentsPerCommercialUnit: 2, quantityUnit: '套' }).commercialQuantity).toBe(2400);
    // 若误用 quantity_unit='三件套' 会得到 1600(错)
    expect(deriveQuantityContext({ physicalQuantity: 4800, quantityUnit: '三件套' }).commercialQuantity).toBe(1600);
  });
});

describe('⭐ 物料需求 = 基准 × 单耗,基准必须与 consumption_basis 同口径', () => {
  const bomSrc = readFileSync('app/actions/bom.ts', 'utf-8');

  it('pieces_qty 存**与单耗同口径**的基数(每套单耗 → 存套数),不是物理件数', () => {
    expect(bomSrc).toContain('pieces_qty: basisQtyOf(');
    expect(bomSrc).not.toMatch(/pieces_qty:\s*poQty\b/);
  });

  it('换算用逐款真实倍率,不看 quantity_unit 字符串', () => {
    expect(bomSrc).toContain('mulByStyleColor');
    expect(bomSrc).toContain('全单一致才换算,混合不猜');
  });

  it('1022977:physical 13200 ÷ mul2 = 6600 套 × 0.88 = 5808kg(不是 13200×0.88=11616)', () => {
    const physical = 13200, mul = 2, cons = 0.88;
    expect((physical / mul) * cons).toBe(5808);
    expect(physical * cons).toBe(11616);          // 修复前的错值
  });

  it('1022967 混合倍率:mul=1 款不换算、mul=2 款除以 2', () => {
    expect((2400 / 1) * 0.6).toBe(1440);          // SP1581-B
    expect(Math.round((4800 / 2) * 1.215)).toBe(2916);  // SP1770
  });

  it('域不变量:PER_SET 用 commercial、PER_PIECE 才用 physical', () => {
    // 记录为可执行断言,防止未来又"所有面料都按 physical"
    const perSet = (commercial: number, cons: number) => commercial * cons;
    const perPiece = (physical: number, cons: number) => physical * cons;
    expect(perSet(10200, 0.88)).toBe(8976);
    expect(perPiece(20400, 0.44)).toBe(8976);     // 同一结果需配套的单耗口径
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

  // ⚠️ 算料/成本/报价基准必须是**商业数量(套数)** —— 单耗本身是「每套」口径
  //    (1022967 实证:mul=1 款单耗 0.6、mul=2 款单耗 1.215 ≈ 2×0.6)。
  //    2026-08-12 一度误改成 physical,把 1022977 面料需求从 8976kg 翻成 17952kg,已回退。
  for (const f of ['app/actions/procurement-items.ts', 'app/actions/procurement-cost.ts', 'app/actions/quote-baseline.ts']) {
    it(`${f} 算料基准用商业数量(groupCommercialQty),不得用 physical`, () => {
      const src = readFileSync(f, 'utf-8');
      expect(src).toContain('groupCommercialQty');
      expect(src, `${f} 不得用 groupPhysicalPieceQty 当算料基准(会把需求翻倍)`).not.toContain('groupPhysicalPieceQty');
    });
  }
});

/**
 * sizes 网格的口径(2026-08-16 用生产库校准,采购 P0 辅料分配时发现)。
 *
 * ⚠️ 历史文档错误(不改历史迁移文件,在此登记):
 *   `supabase/migrations/20260622_add_order_line_items.sql` 第 19 行注释写
 *   `qty_pcs 权威数量(件)= Σsizes × set_multiplier` —— **这句是错的**。
 *   已执行的迁移文件不回头改(会打乱 migration history 语义),以本测试为准。
 *
 * 生产库实测(service-role 只读):
 *   QM-20260812-006  Σsizes 2208 == qty_pcs 2208,set_mul 1
 *   QM-20260812-002  Σsizes 1800 == qty_pcs 1800,set_mul 1
 *   QM-20260717-002  四行 Σsizes 960/480/480/480 == 各自 qty_pcs,set_mul 2
 *                    → Σ(qty_pcs × set_mul) = 2400 × 2 = 4800 = orders.quantity ✓
 *
 * canonical 口径:
 *   Σ sizes         = qty_pcs = commercial quantity(套数)
 *   physical pieces = qty_pcs × set_multiplier
 *   orders.quantity = Σ(qty_pcs × set_multiplier) = physical pieces
 */
describe('sizes 网格 = 商业数量(套数),不是物理件数', () => {
  // 生产实测:套装单,尺码格按套录,件/套=2
  const SET_ORDER = [
    { style_no: 'A', sizes: { S: 240, M: 480, L: 240 }, qty_pcs: 960, set_multiplier: 2 },
    { style_no: 'B', sizes: { S: 120, M: 240, L: 120 }, qty_pcs: 480, set_multiplier: 2 },
    { style_no: 'C', sizes: { S: 120, M: 240, L: 120 }, qty_pcs: 480, set_multiplier: 2 },
    { style_no: 'D', sizes: { S: 120, M: 240, L: 120 }, qty_pcs: 480, set_multiplier: 2 },
  ];
  const sumSizes = (s: Record<string, number>) => Object.values(s).reduce((a, b) => a + b, 0);

  it('Σsizes == qty_pcs(而不是 qty_pcs × set_multiplier)', () => {
    for (const r of SET_ORDER) expect(sumSizes(r.sizes)).toBe(r.qty_pcs);
  });

  it('物理件数 = Σsizes × set_multiplier;整单合计 = orders.quantity(4800)', () => {
    const physical = SET_ORDER.reduce((a, r) => a + sumSizes(r.sizes) * r.set_multiplier, 0);
    expect(physical).toBe(4800);
    expect(sumPhysicalPieceQty(SET_ORDER)).toBe(4800);
  });

  it('商业数量合计 = Σ全部 sizes = 2400 套(不等于件数)', () => {
    const commercial = SET_ORDER.reduce((a, r) => a + sumSizes(r.sizes), 0);
    expect(commercial).toBe(2400);
    expect(sumCommercialQty(SET_ORDER)).toBe(2400);
    expect(commercial).not.toBe(4800);
  });

  it('非套装单:套数 == 件数(set_multiplier=1),两口径不该被混用但数值相同', () => {
    const plain = [{ style_no: '31453R', sizes: { S: 368, M: 736, L: 736, XL: 368 }, qty_pcs: 2208, set_multiplier: 1 }];
    expect(sumSizes(plain[0].sizes)).toBe(2208);
    expect(sumCommercialQty(plain)).toBe(2208);
    expect(sumPhysicalPieceQty(plain)).toBe(2208);
  });

  it('历史迁移注释的公式若成立会得出 4800 套 —— 用它当套数就会翻倍', () => {
    // 记录反例:把「Σsizes × set_multiplier」当成 qty_pcs(商业数量)会得到 4800,
    // 而真实 qty_pcs 合计是 2400。这正是 1022977 那类翻倍事故的形状。
    const wrong = SET_ORDER.reduce((a, r) => a + sumSizes(r.sizes) * r.set_multiplier, 0);
    const right = SET_ORDER.reduce((a, r) => a + r.qty_pcs, 0);
    expect(wrong).toBe(4800);
    expect(right).toBe(2400);
    expect(wrong).toBe(right * 2);
  });
});
