import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isStatCountableOrder, summarizeEffectiveOrderQuantity, orderStatPieces } from '../analytics-metrics.ts';

describe('analytics quantity metrics', () => {
  // 口径由 2026-07-27 CEO 拍板:贸易/经销都是真实业务,要算;只排 取消/关闭/样品/询价。
  it('counts production and trade orders, excludes cancelled/closed/sample/inquiry', () => {
    assert.equal(isStatCountableOrder({ quantity: 100, order_purpose: 'production', lifecycle_status: '执行中' }), true);
    assert.equal(isStatCountableOrder({ quantity: 100, order_purpose: 'trade', lifecycle_status: '执行中' }), true);
    assert.equal(isStatCountableOrder({ quantity: 100, order_purpose: 'sample', lifecycle_status: '执行中' }), false);
    assert.equal(isStatCountableOrder({ quantity: 100, order_purpose: 'inquiry', lifecycle_status: '执行中' }), false);
    assert.equal(isStatCountableOrder({ quantity: 100, order_purpose: 'production', lifecycle_status: '已取消' }), false);
    assert.equal(isStatCountableOrder({ quantity: 100, order_purpose: 'production', lifecycle_status: '已关闭' }), false);
  });

  it('summarizes with the same scope the customer page uses, and keeps the scope explicit', () => {
    const metric = summarizeEffectiveOrderQuantity([
      { quantity: 2400, order_purpose: 'production', lifecycle_status: '执行中' },
      { quantity: 600, order_purpose: 'trade', lifecycle_status: '执行中' },
      { quantity: 1200, order_purpose: 'production', lifecycle_status: '已完成' },
      { quantity: 999, order_purpose: 'sample', lifecycle_status: '执行中' },
      { quantity: 999, order_purpose: 'production', lifecycle_status: '已取消' },
    ]);

    assert.equal(metric.orderCount, 3);
    assert.equal(metric.totalQuantity, 4200);   // 含 600 件贸易单
    assert.equal(metric.scopeLabel, '有效订单总件数');
    assert.match(metric.scopeHint, /客户年度目标口径不同/);
  });

  describe('orderStatPieces 套→件', () => {
    it('有明细时按 Σ(qty_pcs × set_multiplier) 算,2-pack 行算两件', () => {
      assert.equal(orderStatPieces({ quantity: 100 }, [{ qty_pcs: 600, set_multiplier: 2 }, { qty_pcs: 300, set_multiplier: 1 }]), 1500);
    });
    it('无明细时回退 orders.quantity', () => {
      assert.equal(orderStatPieces({ quantity: 880 }, []), 880);
      assert.equal(orderStatPieces({ quantity: 880 }, undefined), 880);
    });
    // 回归护栏(2026-07-30):只建了明细行、没录 qty_pcs 的单原本整单静默算 0 件,
    // 实测 4 单如此(QM-20260727-005 等),合计 28,964 件凭空消失。
    it('明细行存在但件数全为 0/空 → 回退 quantity,不能算成 0 件', () => {
      assert.equal(orderStatPieces({ quantity: 21984 }, [{ qty_pcs: 0, set_multiplier: 1 }, { qty_pcs: null }]), 21984);
      assert.equal(orderStatPieces({ quantity: 3600 }, [{ qty_pcs: null, set_multiplier: null }]), 3600);
    });
  });

  // 回归护栏(2026-07-30):总览曾用一个额外排 trade 的独立判定,导致总览比客户页加总少了整整
  // 21 张贸易单 / 325,126 件。两处必须永远同一个口径。
  it('aggregate scope matches the per-customer scope order-for-order', () => {
    const orders = [
      { id: 'a', quantity: 10, order_purpose: 'production', lifecycle_status: '执行中' },
      { id: 'b', quantity: 20, order_purpose: 'trade', lifecycle_status: '执行中' },
      { id: 'c', quantity: 30, order_purpose: 'distribution', lifecycle_status: '已完成' },
      { id: 'd', quantity: 40, order_purpose: 'sample', lifecycle_status: '执行中' },
      { id: 'e', quantity: 50, order_purpose: 'trade', lifecycle_status: '已取消' },
    ];
    const perCustomer = orders.filter(isStatCountableOrder).reduce((s, o) => s + o.quantity, 0);
    assert.equal(summarizeEffectiveOrderQuantity(orders).totalQuantity, perCustomer);
  });
});
