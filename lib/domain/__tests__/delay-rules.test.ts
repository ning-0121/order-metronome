import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDelayRequest } from '../delay-rules';

test('hold_delivery allows multi-day delay and preserves customer delivery', () => {
  const result = validateDelayRequest({
    stepKey: 'pre_production_sample_ready',
    category: 'internal',
    currentDueAt: '2026-07-10T00:00:00Z',
    proposedDueAt: '2026-07-13T00:00:00Z',
    mode: 'hold_delivery',
  });

  assert.equal(result.allowed, true);
  assert.equal(result.delayDays, 3);
  assert.equal(result.willPushFinalDeliveryDate, false);
  assert.equal(result.remainingBufferDays, 0);
  assert.match(result.reason, /剩余缓冲 0 天/);
});

test('hold_delivery reports risk when delay exceeds buffer', () => {
  const result = validateDelayRequest({
    stepKey: 'pre_production_sample_ready',
    category: 'internal',
    currentDueAt: '2026-07-10T00:00:00Z',
    proposedDueAt: '2026-07-15T00:00:00Z',
    mode: 'hold_delivery',
  });

  assert.equal(result.allowed, true);
  assert.equal(result.remainingBufferDays, -2);
  assert.equal(result.riskLevel, 'high');
  assert.match(result.reason, /已超出缓冲 2 天/);
});

