import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyDispatchQueueStatus, summarizeDispatchQueue } from '../dispatch-queue';

test('classifyDispatchQueueStatus treats factory_id as assigned factory truth', () => {
  assert.equal(classifyDispatchQueueStatus({ factory_id: 'f1', production_follow_up_id: 'u1' }), 'ready');
  assert.equal(classifyDispatchQueueStatus({ factory_id: 'f1' }), 'missing_follow_up');
  assert.equal(classifyDispatchQueueStatus({ production_follow_up_id: 'u1' }), 'missing_factory');
  assert.equal(classifyDispatchQueueStatus({}), 'both_missing');
});

test('summarizeDispatchQueue counts only unassigned rows', () => {
  const summary = summarizeDispatchQueue([
    { factory_id: 'f1', production_follow_up_id: 'u1' },
    { factory_id: 'f1' },
    { production_follow_up_id: 'u1' },
    {},
  ]);
  assert.equal(summary.total, 3);
  assert.equal(summary.missing_factory, 1);
  assert.equal(summary.missing_follow_up, 1);
  assert.equal(summary.both_missing, 1);
});
