import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertToolAuthorized, executeAuthorizedTool } from '../tool-safety';

describe('tool safety', () => {
  it('allows read-only and draft operations', () => {
    assert.doesNotThrow(() => assertToolAuthorized({ scene: 'finance.reconcile', safetyLevel: 'READ_ONLY' }));
    assert.doesNotThrow(() => assertToolAuthorized({ scene: 'finance.reconcile', safetyLevel: 'DRAFT' }));
  });

  it('requires approval for ordinary writes and forbids Finance AI writes', () => {
    assert.throws(() => assertToolAuthorized({ scene: 'order.update', safetyLevel: 'WRITE_REQUIRES_APPROVAL' }));
    assert.doesNotThrow(() => assertToolAuthorized({ scene: 'order.update', safetyLevel: 'WRITE_REQUIRES_APPROVAL', approvedByHuman: true }));
    assert.throws(() => assertToolAuthorized({ scene: 'finance.update', safetyLevel: 'WRITE_REQUIRES_APPROVAL', approvedByHuman: true }));
  });

  it('blocks the handler before a forbidden Finance write can run', async () => {
    let executed = false;
    await assert.rejects(executeAuthorizedTool(
      { scene: 'finance.post-entry', safetyLevel: 'WRITE_REQUIRES_APPROVAL', approvedByHuman: true },
      () => { executed = true; },
    ));
    assert.equal(executed, false);
  });
});
