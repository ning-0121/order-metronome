import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyProductionTasks } from '../workbench';
import type { ProductionOrderRow } from '@/app/actions/production-center';

const row = (overrides: Partial<ProductionOrderRow> = {}): ProductionOrderRow => ({
  order_id: 'test-order', order_no: 'QM-TEST', internal_order_no: 'TEST-001', po_number: 'PO-1', style_no: 'S-1',
  production_follow_up_id: null, production_follow_up_name: null, pending_delay: false,
  customer_name: 'TEST', factory_name: null, quantity: 100, factory_date: null, etd: null,
  stage: 'awaiting_procurement', risk: false, has_mo: false,
  material: { total: 2, received: 0, in_transit: 0, pending: 2 }, kickoff: null, completion: null,
  ...overrides,
});

describe('production role workbench classification', () => {
  it('gives supervisors actionable intake, factory and material queues', () => {
    assert.deepEqual(classifyProductionTasks(row(), 'supervisor').map((t) => t.key), ['intake', 'assign', 'factory']);
  });
  it('gives follow-up an explicit factory action', () => {
    assert.equal(classifyProductionTasks(row(), 'follow_up').some((t) => t.key === 'contact_factory'), true);
  });
  it('creates QC inspection and release tasks only from production stage truth', () => {
    assert.ok(classifyProductionTasks(row({ stage: 'in_production' }), 'qc').map((t) => t.key).includes('inspection'));
    assert.ok(classifyProductionTasks(row({ stage: 'ready_to_ship' }), 'qc').map((t) => t.key).includes('release'));
  });
  it('marks overdue work urgent', () => {
    assert.equal(classifyProductionTasks(row({ risk: true }), 'supervisor').find((t) => t.key === 'overdue')?.urgent, true);
  });
  it('shows delay and assigned follow-up queues from existing truth', () => {
    const keys = classifyProductionTasks(row({ production_follow_up_id: 'u1', production_follow_up_name: '跟单A', pending_delay: true }), 'supervisor').map((t) => t.key);
    assert.ok(keys.includes('assigned')); assert.ok(keys.includes('delay')); assert.ok(!keys.includes('assign'));
  });
});
