import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateRequirementFromContext,
  deriveOrderQuantityContext,
  formatQuantityDisplay,
  quantityForBasis,
  quantityLabelForBasis,
} from '../quantity-engine.ts';

test('2400套 resolves to 4800 pieces and 2400 commercial units', () => {
  const ctx = deriveOrderQuantityContext({ physicalQuantity: 4800, quantityUnit: '套' });
  assert.equal(ctx.physicalQuantity, 4800);
  assert.equal(ctx.componentsPerCommercialUnit, 2);
  assert.equal(ctx.commercialQuantity, 2400);
  assert.equal(formatQuantityDisplay(ctx), '2400套（折合4800件）');
});

test('PER_SET uses commercial quantity, PER_PIECE uses physical quantity', () => {
  const ctx = deriveOrderQuantityContext({ physicalQuantity: 4800, quantityUnit: '套' });
  assert.equal(quantityForBasis(ctx, 'PER_SET'), 2400);
  assert.equal(quantityForBasis(ctx, 'PER_PIECE'), 4800);
  assert.equal(quantityForBasis(ctx, 'PER_COMPONENT'), 4800);
  assert.equal(quantityForBasis(ctx, 'PER_ORDER'), 1);
  assert.equal(quantityForBasis(ctx, 'MANUAL_TOTAL'), 1);
  assert.equal(quantityForBasis(ctx, null), 2400);
});

test('processing fee and accessory budget follow commercial quantity', () => {
  const ctx = deriveOrderQuantityContext({ physicalQuantity: 4800, quantityUnit: '套' });
  const cmt = calculateRequirementFromContext({ consumption: 42, quantity: ctx, basis: 'PER_SET' });
  const accessory = calculateRequirementFromContext({ consumption: 3, quantity: ctx, basis: 'PER_SET' });
  assert.equal(cmt.gross, 100800);
  assert.equal(accessory.gross, 7200);
});

test('per-piece accessory stays on physical quantity', () => {
  const ctx = deriveOrderQuantityContext({ physicalQuantity: 4800, quantityUnit: '套' });
  const accessory = calculateRequirementFromContext({ consumption: 3, quantity: ctx, basis: 'PER_PIECE' });
  assert.equal(accessory.gross, 14400);
});

test('decimal precision survives the shared engine', () => {
  const ctx = deriveOrderQuantityContext({ physicalQuantity: 15400, quantityUnit: '套' });
  const fabric = calculateRequirementFromContext({ consumption: 0.672384, quantity: ctx, basis: 'PER_SET' });
  assert.equal(fabric.gross, 5177.3568);
});

test('ambiguous records surface needs review', () => {
  const ctx = deriveOrderQuantityContext({ physicalQuantity: 4800, lineItemMultipliers: [2, 3] });
  assert.equal(ctx.needsReview, true);
  assert.equal(ctx.reviewReason?.includes('不一致'), true);
  assert.equal(quantityLabelForBasis('PER_SET'), '每套');
  assert.equal(quantityForBasis(ctx, 'PER_SET'), null);
});

test('unknown unit falls back to explicit review state', () => {
  const ctx = deriveOrderQuantityContext({ physicalQuantity: 4800, quantityUnit: null, lineItemMultipliers: [] });
  assert.equal(ctx.needsReview, true);
  assert.equal(ctx.reviewReason, '数量单位待确认，默认按件处理');
  assert.equal(formatQuantityDisplay(ctx), '4800件（数量基准待确认）');
  assert.equal(quantityForBasis(ctx, 'PER_SET'), 4800);
  assert.equal(calculateRequirementFromContext({ consumption: 0.67, quantity: ctx, basis: 'PER_SET' }).gross, 3216);
});
