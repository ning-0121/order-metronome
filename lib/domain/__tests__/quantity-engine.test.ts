import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateRequirementFromContext,
  deriveOrderQuantityContext,
  formatQuantityDisplay,
  measurementLabelForBasis,
  resolveQuantityForBasis,
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

test('measurement bases require explicit measurement quantities', () => {
  const ctx = deriveOrderQuantityContext({ physicalQuantity: 4800, quantityUnit: '套' });
  const kg = calculateRequirementFromContext({ consumption: 2, quantity: ctx, basis: 'PER_KG' });
  assert.equal(kg.status, 'NEEDS_MEASUREMENT_QUANTITY');
  assert.equal(kg.missingMeasurementLabel, '公斤总需');
  assert.equal(kg.gross, null);
  assert.equal(quantityForBasis(ctx, 'PER_KG'), null);
  assert.equal(measurementLabelForBasis('PER_METER'), '米数总需');

  const resolved = resolveQuantityForBasis({
    ...ctx,
    measurementQuantity: 7,
    measurementUnit: 'kg',
  }, 'PER_KG');
  assert.equal(resolved.status, 'OK');
  assert.equal(resolved.quantity, 7);
});

test('processing fee and accessory budget follow commercial quantity', () => {
  const ctx = deriveOrderQuantityContext({ physicalQuantity: 4800, quantityUnit: '套' });
  const cmt = calculateRequirementFromContext({ consumption: 42, quantity: ctx, basis: 'PER_SET' });
  const accessory = calculateRequirementFromContext({ consumption: 3, quantity: ctx, basis: 'PER_SET' });
  assert.equal(cmt.gross, 100800);
  assert.equal(accessory.gross, 7200);
});

test('PER_ORDER and MANUAL_TOTAL resolve to 1', () => {
  const ctx = deriveOrderQuantityContext({ physicalQuantity: 4800, quantityUnit: '套' });
  const order = calculateRequirementFromContext({ consumption: 99, quantity: ctx, basis: 'PER_ORDER' });
  const manual = calculateRequirementFromContext({ consumption: 99, quantity: ctx, basis: 'MANUAL_TOTAL' });
  assert.equal(order.quantity, 1);
  assert.equal(manual.quantity, 1);
  assert.equal(order.gross, 99);
  assert.equal(manual.gross, 99);
});

test('per-piece accessory stays on physical quantity', () => {
  const ctx = deriveOrderQuantityContext({ physicalQuantity: 4800, quantityUnit: '套' });
  const accessory = calculateRequirementFromContext({ consumption: 3, quantity: ctx, basis: 'PER_PIECE' });
  assert.equal(accessory.gross, 14400);
});

test('measurement bases multiply explicit quantities by the provided unit totals', () => {
  const ctx = deriveOrderQuantityContext({ physicalQuantity: 4800, quantityUnit: '套' });
  const kg = calculateRequirementFromContext({ consumption: 0.672384, quantity: { ...ctx, measurementQuantity: 7700, measurementUnit: 'kg' }, basis: 'PER_KG' });
  const meter = calculateRequirementFromContext({ consumption: 1.5, quantity: { ...ctx, measurementQuantity: 12, measurementUnit: 'm' }, basis: 'PER_METER' });
  const sqm = calculateRequirementFromContext({ consumption: 2, quantity: { ...ctx, measurementQuantity: 3, measurementUnit: 'sqm' }, basis: 'PER_SQUARE_METER' });
  const yard = calculateRequirementFromContext({ consumption: 4, quantity: { ...ctx, measurementQuantity: 5, measurementUnit: 'yard' }, basis: 'PER_YARD' });
  const pack = calculateRequirementFromContext({ consumption: 6, quantity: { ...ctx, measurementQuantity: 7, measurementUnit: 'pack' }, basis: 'PER_PACK' });
  assert.equal(kg.gross, 5177.3568);
  assert.equal(meter.gross, 18);
  assert.equal(sqm.gross, 6);
  assert.equal(yard.gross, 20);
  assert.equal(pack.gross, 42);
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

test('ambiguous rows stop before downstream totals', () => {
  const ctx = deriveOrderQuantityContext({ physicalQuantity: 4800, lineItemMultipliers: [2, 3] });
  const result = calculateRequirementFromContext({ consumption: 2, quantity: ctx, basis: 'PER_SET' });
  assert.equal(result.status, 'NEEDS_REVIEW');
  assert.equal(result.gross, null);
  assert.equal(result.quantity, null);
});
