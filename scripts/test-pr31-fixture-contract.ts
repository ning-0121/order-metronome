import assert from 'node:assert/strict';
import {
  PR31_FIXTURE_TYPE,
  isAllowedFixtureTransition,
  isPr31FixtureType,
  normalizeBudgetUnitPriceInput,
  canCleanupFixture,
  validateCleanupAssets,
  type Pr31FixtureAsset,
  type Pr31FixtureRecord,
} from '../lib/domain/pr31-fixture.ts';

function testFixtureType() {
  assert.equal(isPr31FixtureType(PR31_FIXTURE_TYPE), true);
  assert.equal(isPr31FixtureType('PR31_BUDGET_UATX'), false);
}

function testTransitions() {
  assert.equal(isAllowedFixtureTransition('DRAFT', 'ACTIVE'), true);
  assert.equal(isAllowedFixtureTransition('ACTIVE', 'CLEANUP_PENDING'), true);
  assert.equal(isAllowedFixtureTransition('CLEANED', 'ACTIVE'), false);
  assert.equal(isAllowedFixtureTransition('EXPIRED', 'ACTIVE'), false);
}

function testBudgetNormalization() {
  assert.deepEqual(normalizeBudgetUnitPriceInput(null), { value: null, error: null });
  assert.deepEqual(normalizeBudgetUnitPriceInput('', { allowZero: true }), { value: null, error: null });
  assert.deepEqual(normalizeBudgetUnitPriceInput('3.0000', { allowZero: true }), { value: 3, error: null });
  assert.deepEqual(normalizeBudgetUnitPriceInput(0, { allowZero: true }), { value: 0, error: null });
  assert.match(normalizeBudgetUnitPriceInput(-1, { allowZero: true }).error || '', /不能为负数/);
  assert.match(normalizeBudgetUnitPriceInput('x', { allowZero: true }).error || '', /有效数字/);
}

function testCleanupGuards() {
  const record: Pr31FixtureRecord = {
    id: 'fixture-1',
    fixtureType: PR31_FIXTURE_TYPE,
    status: 'ACTIVE',
    ownerUserId: 'user-1',
    expiresAt: null,
    targetOrderId: 'order-1',
    targetBomId: 'bom-1',
    targetBaselineId: null,
  };
  assert.equal(canCleanupFixture(record).ok, true);
  assert.equal(canCleanupFixture({ ...record, status: 'CLEANED' }).ok, false);
  assert.equal(canCleanupFixture({ ...record, expiresAt: '2020-01-01T00:00:00.000Z' }).ok, false);
  assert.equal(canCleanupFixture({ ...record, targetBomId: null }).ok, false);
}

function testAssetValidation() {
  const assets: Pr31FixtureAsset[] = [
    { assetTable: 'orders', assetId: 'o1', assetRole: 'order', cleanupMode: 'restore' },
    { assetTable: 'materials_bom', assetId: 'b1', assetRole: 'bom', cleanupMode: 'delete' },
  ];
  assert.equal(validateCleanupAssets(assets, 'fixture-1').ok, true);
  assert.equal(validateCleanupAssets([{ assetTable: '', assetId: 'x', assetRole: 'bom', cleanupMode: 'delete' }], 'fixture-1').ok, false);
}

testFixtureType();
testTransitions();
testBudgetNormalization();
testCleanupGuards();
testAssetValidation();

console.log('PR31 fixture contract tests passed');
