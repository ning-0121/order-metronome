import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canActOnDeferralStep, deferralChainFor } from '../deferral-routing';

describe('two-stage production delay approval', () => {
  it('keeps production impact and customer commitment as distinct steps', () => {
    const production = deferralChainFor('production');
    assert.deepEqual(production, ['production_manager']);
    const customerImpact = [...production, 'commercial_manager'];
    assert.notEqual(customerImpact[0], customerImpact[1]);
    assert.equal(canActOnDeferralStep({ roles:['production_manager'], requiredRole:'commercial_manager', actorId:'pm', requesterId:'follow' }), false);
    assert.equal(canActOnDeferralStep({ roles:['sales_manager'], requiredRole:'commercial_manager', actorId:'salesm', requesterId:'follow' }), true);
    assert.equal(canActOnDeferralStep({ roles:['order_manager'], requiredRole:'commercial_manager', actorId:'orderm', requesterId:'follow' }), true);
  });
  it('denies requester self approval at either stage', () => {
    assert.equal(canActOnDeferralStep({ roles:['production_manager'], requiredRole:'production_manager', actorId:'same', requesterId:'same' }), false);
  });
});
