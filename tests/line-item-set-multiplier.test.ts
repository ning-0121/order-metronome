/**
 * 套装单的件数口径(2026-08-03 事故后立)。
 *
 * 富录入表的约定(LineItemMatrixEditor 的 setMulOf):
 *   尺码格里录的是**套数**;物理件数 = 套数 × 件/套(set_multiplier,款级可填)。
 * 落库时 order_line_items.qty_pcs 存套数,set_multiplier 存件/套,
 * 于是 Σ(qty_pcs × set_multiplier) 应当等于订单头 orders.quantity(件数)。
 *
 * 事故:createOrder 把 set_multiplier **硬编码成 1**,把表单传来的款级倍率扔了。
 * 结果套装单的 Σ(qty_pcs × set_multiplier) 得到的是套数,永远比订单头少整整一个倍数:
 *   QM-20260711-004「套」 头 3360 / 明细 1680
 *   QM-20260710-016「套」 头 1200 / 明细  600
 * 两层后果:① /admin/missing-line-items 对所有套装单误报「缺一半明细」;
 *          ② 拿 Σ(qty_pcs×mul) 当件数的下游(算料/采购/装箱)会少备一半到三分之二的料
 *             —— 正是 [[set-order-fabric-per-set]] 记的那个坑。
 *
 * 这里锁的是**源码里不许再退回硬编码**,以及口径换算本身。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ordersSrc = readFileSync(resolve(process.cwd(), 'app/actions/orders.ts'), 'utf-8');

describe('建单落明细时必须带上款级件/套', () => {
  it('不许再把 set_multiplier 硬编码成 1', () => {
    // 允许出现在注释里(上面那段说明就提到了),所以只查真正的赋值写法
    expect(ordersSrc).not.toMatch(/^\s*set_multiplier:\s*1\s*,\s*$/m);
  });

  it('从表单的款级 set_multiplier 取值,非正数才回落 1', () => {
    expect(ordersSrc).toMatch(/set_multiplier:\s*Number\(st\?\.set_multiplier\)\s*>\s*0\s*\?\s*Number\(st\.set_multiplier\)\s*:\s*1/);
  });
});

describe('件数换算口径', () => {
  // 与 LineItemMatrixEditor / missing-line-items 页保持同一公式
  const pieces = (lines: Array<{ qty_pcs: number; set_multiplier: number }>) =>
    lines.reduce((a, l) => a + l.qty_pcs * (l.set_multiplier > 0 ? l.set_multiplier : 1), 0);

  it('套装:1680 套 × 2 件/套 = 3360 件(对上 QM-20260711-004 的订单头)', () => {
    expect(pieces([{ qty_pcs: 1680, set_multiplier: 2 }])).toBe(3360);
  });

  it('三件套:800 套 × 3 = 2400 件', () => {
    expect(pieces([{ qty_pcs: 800, set_multiplier: 3 }])).toBe(2400);
  });

  it('非套装:倍率 1,件数就是录入数', () => {
    expect(pieces([{ qty_pcs: 786, set_multiplier: 1 }])).toBe(786);
  });

  it('倍率丢成 1 正是事故形态:套装单会少一半', () => {
    const 正确 = pieces([{ qty_pcs: 1680, set_multiplier: 2 }]);
    const 事故 = pieces([{ qty_pcs: 1680, set_multiplier: 1 }]);
    expect(事故).toBe(正确 / 2);
  });
});
