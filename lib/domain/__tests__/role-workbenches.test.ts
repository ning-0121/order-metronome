import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ROLE_WORKBENCH_QUEUES, workbenchesForRoles } from '../role-workbenches';

describe('role workbench contracts', () => {
  it('keeps post-handoff execution tasks out of Development', () => {
    assert.ok(ROLE_WORKBENCH_QUEUES.business_development.includes('PO 待交接'));
    assert.ok(!ROLE_WORKBENCH_QUEUES.business_development.includes('生产协调'));
  });
  it('keeps Business Execution active through shipment and closure', () => {
    assert.ok(ROLE_WORKBENCH_QUEUES.business_execution.includes('出货准备'));
    assert.ok(ROLE_WORKBENCH_QUEUES.business_execution.includes('待关闭订单'));
  });
  it('keeps follow-up/QC active through packing and shipment', () => {
    assert.ok(ROLE_WORKBENCH_QUEUES.production_follow_up_qc.includes('待包装'));
    assert.ok(ROLE_WORKBENCH_QUEUES.production_follow_up_qc.includes('待出货跟进'));
  });
  it('gives multi-role users a union without inventing another workbench', () => {
    assert.deepEqual(workbenchesForRoles(['merchandiser', 'production']), ['business_execution', 'production_follow_up_qc']);
  });
});
