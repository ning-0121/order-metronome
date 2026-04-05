/**
 * Agent 建议生成器单元测试
 */

import { generateSuggestionsForOrder } from '../generateSuggestions';

const mockOrder = { id: 'order-1', order_no: 'QM-TEST-001', customer_name: 'TestCustomer', factory_name: 'TestFactory' };
const mockProfiles = [
  { user_id: 'user-1', name: 'Alice', email: 'alice@test.com', roles: ['sales'] },
  { user_id: 'user-2', name: 'Bob', email: 'bob@test.com', roles: ['merchandiser'] },
];

describe('generateSuggestionsForOrder', () => {
  test('returns empty for order with no issues', () => {
    const milestones = [
      { id: 'm1', step_key: 'po_confirmed', name: 'PO确认', status: 'done', due_at: '2026-04-01', owner_role: 'sales', owner_user_id: 'user-1', evidence_required: false, is_critical: true },
    ];
    const result = generateSuggestionsForOrder(mockOrder, milestones, mockProfiles, []);
    expect(result.length).toBe(0);
  });

  test('generates nudge for overdue milestone', () => {
    const milestones = [
      { id: 'm1', step_key: 'po_confirmed', name: 'PO确认', status: 'in_progress', due_at: '2026-03-30', owner_role: 'sales', owner_user_id: 'user-1', evidence_required: false, is_critical: true },
    ];
    const result = generateSuggestionsForOrder(mockOrder, milestones, mockProfiles, []);
    const nudge = result.find(s => s.actionType === 'send_nudge');
    expect(nudge).toBeTruthy();
    expect(nudge?.title).toContain('超期');
  });

  test('generates assign_owner for unassigned milestone', () => {
    const milestones = [
      { id: 'm1', step_key: 'po_confirmed', name: 'PO确认', status: 'pending', due_at: '2026-04-10', owner_role: 'sales', owner_user_id: null, evidence_required: false, is_critical: true },
    ];
    const result = generateSuggestionsForOrder(mockOrder, milestones, mockProfiles, []);
    const assign = result.find(s => s.actionType === 'assign_owner');
    expect(assign).toBeTruthy();
    expect(assign?.title).toContain('Alice');
  });

  test('respects dedup - no duplicate suggestions', () => {
    const milestones = [
      { id: 'm1', step_key: 'po_confirmed', name: 'PO确认', status: 'in_progress', due_at: '2026-03-30', owner_role: 'sales', owner_user_id: 'user-1', evidence_required: false, is_critical: true },
    ];
    const existingActions = [
      { dedup_key: 'order-1:send_nudge:m1', status: 'pending', created_at: new Date().toISOString() },
    ];
    const result = generateSuggestionsForOrder(mockOrder, milestones, mockProfiles, existingActions);
    const nudge = result.find(s => s.actionType === 'send_nudge');
    expect(nudge).toBeUndefined(); // dedup should prevent
  });

  test('limits to max 3 suggestions per order', () => {
    const milestones = Array.from({ length: 10 }, (_, i) => ({
      id: `m${i}`, step_key: `step_${i}`, name: `节点${i}`, status: 'in_progress',
      due_at: '2026-03-25', owner_role: 'sales', owner_user_id: 'user-1',
      evidence_required: false, is_critical: true,
    }));
    const result = generateSuggestionsForOrder(mockOrder, milestones, mockProfiles, []);
    expect(result.length).toBeLessThanOrEqual(3);
  });

  test('escalate_ceo triggers with 3+ overdue', () => {
    const milestones = Array.from({ length: 4 }, (_, i) => ({
      id: `m${i}`, step_key: `step_${i}`, name: `节点${i}`, status: 'in_progress',
      due_at: '2026-03-25', owner_role: 'sales', owner_user_id: 'user-1',
      evidence_required: false, is_critical: true,
    }));
    const result = generateSuggestionsForOrder(mockOrder, milestones, mockProfiles, []);
    const escalate = result.find(s => s.actionType === 'escalate_ceo');
    expect(escalate).toBeTruthy();
  });
});
