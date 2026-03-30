import { strict as assert } from 'node:assert';
import { classifyRequirement, REQUIREMENT_PRIORITY, type RequirementType } from '../domain/requirements';

function highestType(types: RequirementType[]): RequirementType {
  for (const t of REQUIREMENT_PRIORITY) {
    if (types.includes(t)) return t;
  }
  return 'new';
}

// Basic unit tests for classifier (can be run with: node --test lib/domain/requirements.test.ts)
describe('classifyRequirement', () => {
  it('classifies risk over others', () => {
    const text = 'If color fastness is not improved it is a high risk of claim from customer.';
    const res = classifyRequirement(text);
    assert.equal(res.type, 'risk');
    assert.ok(res.keywordsHit.length > 0);
  });

  it('classifies change when change keywords present', () => {
    const text = 'Please change the packing to individual polybags instead of bulk packing.';
    const res = classifyRequirement(text);
    assert.equal(res.type, 'change');
  });

  it('classifies pending when asking for confirmation', () => {
    const text = 'Please confirm if plus size upcharge is acceptable?';
    const res = classifyRequirement(text);
    assert.equal(res.type, 'pending');
  });

  it('treats \"looks ok\" and \"should be ok\" as pending (not confirmed)', () => {
    const text1 = 'It looks ok to use this fabric, but please double check shrinkage.';
    const text2 = 'Schedule should be ok if materials arrive on time.';
    const res1 = classifyRequirement(text1);
    const res2 = classifyRequirement(text2);
    assert.equal(res1.type, 'pending');
    assert.equal(res2.type, 'pending');
  });

  it('classifies confirmed when explicit confirmations and no higher-priority flags', () => {
    const text = 'We have confirmed to follow the same packaging as last time, no change needed.';
    const res = classifyRequirement(text);
    assert.equal(res.type, 'confirmed');
  });

  it('falls back to new when no keywords hit', () => {
    const text = 'Please use normal quality carton and standard polybags.';
    const res = classifyRequirement(text);
    assert.equal(res.type, 'new');
  });

  it('respects priority ordering when multiple categories hit', () => {
    const text =
      'We confirmed the packaging change, but this could be a high risk if labels are not updated correctly. Please confirm.';
    const res = classifyRequirement(text);
    // risk + change + pending all present -> risk should win
    assert.equal(res.type, highestType(['risk', 'change', 'pending']));
  });
});

