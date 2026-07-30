import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isStatCountableOrder, summarizeEffectiveOrderQuantity } from '../analytics-metrics.ts';

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
