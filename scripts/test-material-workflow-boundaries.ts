import assert from 'node:assert/strict';
import fs from 'node:fs';

const accessoryAction = fs.readFileSync('app/actions/accessory-import.ts', 'utf8');
const sizeAction = fs.readFileSync('app/actions/size-chart.ts', 'utf8');
const bomAction = fs.readFileSync('app/actions/bom.ts', 'utf8');
const sheetAction = fs.readFileSync('app/actions/manufacturing-order.ts', 'utf8');

assert.match(accessoryAction, /auth\.getUser\(\)/);
assert.match(accessoryAction, /MATCHED_TO_EXISTING/);
assert.match(accessoryAction, /NEW_ACCESSORY/);
assert.match(accessoryAction, /NEEDS_REVIEW/);
assert.match(accessoryAction, /APPROVED/);
assert.match(accessoryAction, /EXCLUDED/);
assert.doesNotMatch(accessoryAction, /from\(['"]purchase_orders['"]\)|submitBomToProcurement|createPurchaseOrder/);
assert.match(accessoryAction, /match_confidence === 1/);
assert.match(sizeAction, /parse_status: 'UPLOADED'/);
assert.match(sizeAction, /parse_status: 'PARSING'/);
assert.match(sizeAction, /parse_status: 'NEEDS_REVIEW'/);
assert.match(sizeAction, /reviewed_by: user\.id/);
for (const field of ['consumption_basis','sample_reference','position_description']) {
  assert.match(bomAction, new RegExp(field)); assert.match(sheetAction, new RegExp(field));
}
console.log('✅ Material workflow authorization and no-auto-PO boundaries passed');
