import { describe, it, expect } from 'vitest';
import { routeReviewerRole, resolveAppeal, withinAppealWindow, APPEAL_WINDOW_DAYS } from '@/lib/domain/scoreAppeal';

describe('routeReviewerRole 域路由', () => {
  it('PO逾期 → 业务经理', () => expect(routeReviewerRole('po_overdue')).toBe('order_manager'));
  it('生产/QC 节点 → 生产主管', () => {
    expect(routeReviewerRole('node_overdue', 'production')).toBe('production_manager');
    expect(routeReviewerRole('node_overdue', 'qc')).toBe('production_manager');
    expect(routeReviewerRole('quality', 'qc')).toBe('production_manager');
  });
  it('采购节点 → 采购经理', () => expect(routeReviewerRole('node_overdue', 'procurement')).toBe('procurement_manager'));
  it('业务/理单/默认 → 业务经理', () => {
    expect(routeReviewerRole('node_overdue', 'merchandiser')).toBe('order_manager');
    expect(routeReviewerRole('node_overdue', null)).toBe('order_manager');
  });
});

describe('resolveAppeal 裁决', () => {
  it('老板 override 优先', () => {
    expect(resolveAppeal({ appeal_type: 'node_overdue', admin_override: 'approved', reviewer_decision: 'rejected' })).toBe('approved');
    expect(resolveAppeal({ appeal_type: 'po_overdue', admin_override: 'rejected' })).toBe('rejected');
  });
  it('任一驳回即驳回', () => {
    expect(resolveAppeal({ appeal_type: 'po_overdue', reviewer_decision: 'approved', finance_decision: 'rejected' })).toBe('rejected');
  });
  it('普通申诉:域经理批即通过', () => {
    expect(resolveAppeal({ appeal_type: 'node_overdue', reviewer_decision: 'approved' })).toBe('approved');
    expect(resolveAppeal({ appeal_type: 'quality', reviewer_decision: null })).toBe('pending');
  });
  it('PO逾期:需域经理+财务双批', () => {
    expect(resolveAppeal({ appeal_type: 'po_overdue', reviewer_decision: 'approved' })).toBe('pending');           // 缺财务
    expect(resolveAppeal({ appeal_type: 'po_overdue', reviewer_decision: 'approved', finance_decision: 'approved' })).toBe('approved');
  });
});

describe('withinAppealWindow 时限', () => {
  const day = 86400000;
  it(`${APPEAL_WINDOW_DAYS} 天内可申诉`, () => {
    const ref = '2026-07-01T00:00:00Z';
    expect(withinAppealWindow(ref, new Date('2026-07-05T00:00:00Z').getTime())).toBe(true);   // 4天
    expect(withinAppealWindow(ref, new Date('2026-07-08T00:00:00Z').getTime())).toBe(true);   // 7天整
    expect(withinAppealWindow(ref, new Date('2026-07-09T00:00:00Z').getTime())).toBe(false);  // 8天,过期
  });
  it('无参照日 → 不卡窗口', () => {
    expect(withinAppealWindow(null, Date.now())).toBe(true);
    expect(withinAppealWindow('bad-date', Date.now())).toBe(true);
  });
});
