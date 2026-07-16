import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canActOnDeferralStep, deferralChainFor } from '@/lib/domain/deferral-routing';
import { compareConsumption, normalizeConsumptionDecimal, normalizeConsumptionUnit } from '../consumption';
import { factoryRecommendationLabel, matchFactory, rankScore } from '../scheduling';

describe('Production Center G-K domain rules', () => {
  it('routes production delay to supervisor and customer commitment to sales next', () => {
    assert.deepEqual(deferralChainFor('production'), ['production_manager']);
    assert.equal(canActOnDeferralStep({ roles: ['production_manager'], requiredRole: 'production_manager', actorId: 'a', requesterId: 'b' }), true);
    assert.equal(canActOnDeferralStep({ roles: ['production_manager'], requiredRole: 'sales_manager', actorId: 'a', requesterId: 'b' }), false);
    assert.equal(canActOnDeferralStep({ roles: ['production'], requiredRole: 'production', actorId: 'same', requesterId: 'same' }), false);
  });
  it('preserves decimal strings and prevents unit mixing', () => {
    for (const value of ['1.05', '0.75', '0.032']) assert.equal(normalizeConsumptionDecimal(value), value);
    assert.equal(normalizeConsumptionUnit('m²'), '平方米/件');
    assert.equal(normalizeConsumptionUnit('kg'), 'kg/件');
    assert.equal(compareConsumption({ quoted: '1.05', actual: '1.01', quotedUnit: '米', actualUnit: '米/件' }).ok, true);
    assert.match(compareConsumption({ quoted: '1.05', actual: '0.75', quotedUnit: '米', actualUnit: '平方米' }).error || '', /单位不一致/);
  });
  it('ranks recommendations without excluding capability mismatches', () => {
    const good = matchFactory({ id: 'a', factory_name: 'A', product_categories: ['上衣'] }, { product_category: '上衣' });
    const mismatch = matchFactory({ id: 'b', factory_name: 'B', product_categories: ['裤子'] }, { product_category: '上衣' });
    assert.ok(rankScore(good, 100, null) > rankScore(mismatch, 100, null));
    assert.equal(factoryRecommendationLabel(good, 100), '推荐');
    assert.equal(factoryRecommendationLabel(mismatch, 100), '品类经验不足');
  });
});
