import { describe, expect, it } from 'vitest';
import { classifyProductionTasks } from '../workbench';
import type { ProductionOrderRow } from '@/app/actions/production-center';

const row = (overrides: Partial<ProductionOrderRow> = {}): ProductionOrderRow => ({
  order_id: 'test-order', order_no: 'QM-TEST', internal_order_no: 'TEST-001', po_number: 'PO-1', style_no: 'S-1',
  customer_name: 'TEST', factory_name: null, quantity: 100, factory_date: null, etd: null,
  stage: 'awaiting_procurement', risk: false, has_mo: false,
  material: { total: 2, received: 0, in_transit: 0, pending: 2 }, kickoff: null, completion: null,
  ...overrides,
});

describe('production role workbench classification', () => {
  it('gives supervisors actionable intake, factory and material queues', () => {
    expect(classifyProductionTasks(row(), 'supervisor').map((t) => t.key)).toEqual(['intake', 'factory', 'material']);
  });
  it('gives follow-up an explicit factory action', () => {
    expect(classifyProductionTasks(row(), 'follow_up').some((t) => t.key === 'contact_factory')).toBe(true);
  });
  it('creates QC inspection and release tasks only from production stage truth', () => {
    expect(classifyProductionTasks(row({ stage: 'in_production' }), 'qc').map((t) => t.key)).toContain('inspection');
    expect(classifyProductionTasks(row({ stage: 'ready_to_ship' }), 'qc').map((t) => t.key)).toContain('release');
  });
  it('marks overdue work urgent', () => {
    expect(classifyProductionTasks(row({ risk: true }), 'supervisor').find((t) => t.key === 'overdue')?.urgent).toBe(true);
  });
});
