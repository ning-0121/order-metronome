import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateShipmentGate, type ShipmentGateInput } from '../shipment-release';

const allPass = (): ShipmentGateInput => ({ business_execution:{passed:true}, qc:{passed:true}, logistics:{passed:true}, finance:{passed:true}, documents:{passed:true}, packing:{passed:true} });
describe('central shipment release gate', () => {
  it('allows only when every applicable gate passes', () => assert.equal(evaluateShipmentGate(allPass()).allowed, true));
  for (const key of ['business_execution','qc','logistics','finance','documents','packing'] as const) {
    it(`blocks missing ${key}`, () => {
      const input = allPass(); input[key] = { passed: false };
      const result = evaluateShipmentGate(input);
      assert.equal(result.allowed, false); assert.equal(result.blockers[0].key, key); assert.ok(result.blockers[0].responsibleRole); assert.ok(result.blockers[0].href);
    });
  }
});
