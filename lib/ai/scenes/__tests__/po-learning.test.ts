import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPOLearningProfile, formatPOLearningContext, normalizeCustomerKey } from '../po-learning';

test('builds a compact profile without quantities, prices or PO values', () => {
  const original = { styles: [{ style_no: 'OLD', product_name: 'Top', colors: [{ sizes: { S: 10 } }] }], unit_price: 99, order_no: 'SECRET-PO' };
  const corrected = [{ style_no: 'NEW', product_name: 'Set', set_multiplier: 2, colors: [{ sizes: { S: 20, M: 30 } }] }];
  const profile = buildPOLearningProfile(original, corrected);
  const serialized = JSON.stringify(profile);
  assert.deepEqual(profile.commonSizeLabels, ['S', 'M']);
  assert.deepEqual(profile.commonSetMultipliers, [2]);
  assert.ok(profile.correctedFields.includes('style_mapping'));
  assert.doesNotMatch(serialized, /SECRET-PO|99|20|30/);
});

test('formats advisory history with current-document precedence', () => {
  const context = formatPOLearningContext([{ version: 1, commonSizeLabels: ['XS', 'S'], commonSetMultipliers: [2], correctedFields: ['size_labels'], styleCountRange: [1, 1] }]);
  assert.match(context, /当前 PO 为准/);
  assert.match(context, /XS, S/);
  assert.match(context, /不能照抄历史值/);
});

test('normalizes customer keys deterministically', () => {
  assert.equal(normalizeCustomerKey('  Demo   CUSTOMER '), 'demo customer');
});
