import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isEffectiveOrderQuantitySource, summarizeEffectiveOrderQuantity } from '../analytics-metrics.ts';

describe('analytics quantity metrics', () => {
  it('excludes cancelled, closed, trade and sample orders from the effective quantity scope', () => {
    assert.equal(isEffectiveOrderQuantitySource({ quantity: 100, order_purpose: 'production', lifecycle_status: '执行中' }), true);
    assert.equal(isEffectiveOrderQuantitySource({ quantity: 100, order_purpose: 'trade', lifecycle_status: '执行中' }), false);
    assert.equal(isEffectiveOrderQuantitySource({ quantity: 100, order_purpose: 'sample', lifecycle_status: '执行中' }), false);
    assert.equal(isEffectiveOrderQuantitySource({ quantity: 100, order_purpose: 'production', lifecycle_status: '已取消' }), false);
    assert.equal(isEffectiveOrderQuantitySource({ quantity: 100, order_purpose: 'production', lifecycle_status: '已关闭' }), false);
  });

  it('summarizes only effective orders and keeps the scope explicit', () => {
    const metric = summarizeEffectiveOrderQuantity([
      { quantity: 2400, order_purpose: 'production', lifecycle_status: '执行中' },
      { quantity: 600, order_purpose: 'trade', lifecycle_status: '执行中' },
      { quantity: 1200, order_purpose: 'production', lifecycle_status: '已完成' },
    ]);

    assert.equal(metric.orderCount, 2);
    assert.equal(metric.totalQuantity, 3600);
    assert.equal(metric.scopeLabel, '有效订单总件数');
    assert.match(metric.scopeHint, /客户年度目标口径不同/);
  });
});
