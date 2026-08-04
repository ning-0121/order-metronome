/**
 * 采购单配平校验(财务契约 v1,2026-08-03)。
 *
 * 背景事故(2026-08-02):小吴提交的对账单金额与供应商汇总不一致 → 海莲签字、圆圆没发现 → 一路批过。
 * 财务侧已把闸门做硬;这里是节拍器的源头闸,让不配平的单**根本送不出去**。
 *
 * 老板决策:金额对不上**绝对不能过**,容差 0.01 元,谈好的折让也必须落成具名行。
 */
import { describe, it, expect } from 'vitest';
import { reconcilePoAmount, lineAmount, PO_AMOUNT_TOLERANCE } from '@/lib/procurement/po-reconcile';

describe('配平通过', () => {
  it('明细合计 = 单头', () => {
    const r = reconcilePoAmount(7020, [
      { ordered_qty: 1000, unit_price: 7.02, ordered_amount: 7020 },
    ]);
    expect(r.ok).toBe(true);
    expect(r.diff).toBe(0);
  });

  it('多行相加也对得上(生产真实case:PO-20260724-001 五行 ¥1113)', () => {
    const r = reconcilePoAmount(1113, [
      { ordered_amount: 63.6 }, { ordered_amount: 63.6 }, { ordered_amount: 63.6 },
      { ordered_amount: 121.9 }, { ordered_amount: 800.3 },
    ]);
    expect(r.ok).toBe(true);
  });

  it('浮点误差在容差内不误伤', () => {
    const r = reconcilePoAmount(0.3, [{ ordered_amount: 0.1 }, { ordered_amount: 0.2 }]);
    expect(r.ok).toBe(true);
  });
});

describe('配平不通过 —— 必须拦住', () => {
  it('财务点名的 PO-20260727-001 形态:明细 7176 vs 单头 7020,差 156', () => {
    const r = reconcilePoAmount(7020, [{ ordered_amount: 7176 }]);
    expect(r.ok).toBe(false);
    expect(r.diff).toBe(-156);
    expect(r.message).toContain('7020.00');
    expect(r.message).toContain('7176.00');
    expect(r.message).toContain('156.00');
    // 必须明确告诉人「折让要落成具名行」,而不是留在差额里
    expect(r.message).toContain('具名');
  });

  it('刚好超过容差就拦(0.02)', () => {
    expect(reconcilePoAmount(100, [{ ordered_amount: 100.02 }]).ok).toBe(false);
  });

  it('刚好等于容差不拦(0.01)', () => {
    expect(reconcilePoAmount(100, [{ ordered_amount: 100.01 }]).ok).toBe(true);
  });

  it('没有明细行 → 拦住(财务无从判断钱花在什么上)', () => {
    const r = reconcilePoAmount(5000, []);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('没有明细行');
  });
});

describe('无底价单不误伤', () => {
  it('price_tbd 放行(补价后再 resync)', () => {
    expect(reconcilePoAmount(0, [], { priceTbd: true }).ok).toBe(true);
    expect(reconcilePoAmount(5000, [], { priceTbd: true }).ok).toBe(true);
  });

  it('单头金额为 0 视为价待定,放行', () => {
    expect(reconcilePoAmount(0, []).ok).toBe(true);
    expect(reconcilePoAmount(null, []).ok).toBe(true);
  });
});

describe('单行金额取值优先级', () => {
  it('ordered_amount > amount > qty×price', () => {
    expect(lineAmount({ ordered_amount: 10, amount: 20, ordered_qty: 3, unit_price: 100 })).toBe(10);
    expect(lineAmount({ amount: 20, ordered_qty: 3, unit_price: 100 })).toBe(20);
    expect(lineAmount({ ordered_qty: 3, unit_price: 100 })).toBe(300);
  });

  it('脏值当 0,不抛异常', () => {
    expect(lineAmount({ ordered_amount: 'abc' as any })).toBe(0);
    expect(lineAmount({})).toBe(0);
  });
});

describe('容差常量按老板决策', () => {
  it('是 0.01 元', () => expect(PO_AMOUNT_TOLERANCE).toBe(0.01));
});
