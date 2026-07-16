import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeRoleToDb } from '../roles';
import {
  addResponsibility, canApproveDecision, canSelfApprove, requiredOwnersAtStage,
  responsibilitiesAfterHandoff, validateAdminOverride,
} from '../responsibility-model';

describe('QIMO canonical responsibility model', () => {
  it('fails closed for empty and unknown roles', () => {
    assert.throws(() => normalizeRoleToDb(null), /角色不能为空/);
    assert.throws(() => normalizeRoleToDb('业务执行经理拼错'), /未知角色/);
  });
  it('hands off overall ownership without deleting development ownership', () => {
    assert.deepEqual(responsibilitiesAfterHandoff({ developmentOwner: 'dev', executionOwner: 'exec' }), {
      development_owner: 'dev', business_execution_owner: 'exec',
    });
  });
  it('adds factory-side ownership without replacing order owner', () => {
    const initial = { business_execution_owner: 'exec', production_manager_owner: 'pm' };
    const assigned = addResponsibility(initial, 'production_follow_up_owner', 'follow');
    assert.equal(assigned.business_execution_owner, 'exec');
    assert.equal(assigned.production_follow_up_owner, 'follow');
  });
  it('retains dual owners through shipment and closure', () => {
    assert.deepEqual(requiredOwnersAtStage('shipment'), ['business_execution_owner', 'production_follow_up_owner', 'logistics_owner']);
    assert.deepEqual(requiredOwnersAtStage('closed'), ['business_execution_owner']);
  });
  it('separates factory, schedule, commercial, QC and finance authority', () => {
    assert.equal(canApproveDecision(['production_manager'], 'factory_finalization'), true);
    assert.equal(canApproveDecision(['production'], 'factory_finalization'), false);
    assert.equal(canApproveDecision(['merchandiser'], 'production_schedule_finalization'), false);
    assert.equal(canApproveDecision(['order_manager'], 'customer_commitment_change'), true);
    assert.equal(canApproveDecision(['production'], 'qc_release'), true);
    assert.equal(canApproveDecision(['merchandiser'], 'payment'), false);
    assert.equal(canApproveDecision(['finance'], 'payment'), true);
  });
  it('prevents self approval and requires an audited admin reason', () => {
    assert.equal(canSelfApprove('same', 'same'), false);
    assert.equal(canSelfApprove('requester', 'manager'), true);
    assert.equal(validateAdminOverride({ roles: ['admin'] }).ok, false);
    assert.equal(validateAdminOverride({ roles: ['admin'], reason: '紧急资源协调' }).ok, true);
  });
  it('multi-role union does not grant unrelated decisions', () => {
    assert.equal(canApproveDecision(['production', 'merchandiser'], 'factory_finalization'), false);
    assert.equal(canApproveDecision(['production_manager', 'finance'], 'payment'), true);
    assert.equal(canApproveDecision(['production_manager'], 'payment'), false);
  });
});
