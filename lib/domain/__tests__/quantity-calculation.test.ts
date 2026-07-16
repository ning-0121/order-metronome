import assert from 'node:assert/strict';
import test from 'node:test';
import { addDecimals, calculateRequirement } from '../quantity-calculation';

test('two-piece component consumption is already per set', () => {
  const total = calculateRequirement({ consumption: addDecimals('0.35', '0.32'), orderSets: 7700, piecesPerSet: 2 });
  assert.equal(total.gross, 5159);
});

test('single garment remains unchanged', () => {
  assert.equal(calculateRequirement({ consumption: 0.67, orderSets: 7700 }).gross, 5159);
});

test('full source precision is preserved', () => {
  assert.equal(calculateRequirement({ consumption: 0.672384, orderSets: 7700 }).gross, 5177.3568);
});

test('explicit loss is applied once and separately', () => {
  const r = calculateRequirement({ consumption: 0.67, orderSets: 7700, lossRatePct: 3 });
  assert.equal(r.gross, 5159);
  assert.equal(r.loss, 154.77);
  assert.equal(r.totalWithLoss, 5313.77);
});

test('explicit per-piece basis converts sets to pieces', () => {
  assert.equal(calculateRequirement({ consumption: 0.2, orderSets: 100, piecesPerSet: 2, basis: 'PER_PIECE' }).gross, 40);
});
