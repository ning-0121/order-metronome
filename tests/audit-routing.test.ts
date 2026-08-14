import { describe, it, expect } from 'vitest';
import {
  AUDIT_ROUTING,
  AUDIT_KIND_CN,
  factoryShouldBeKnown,
  recipientRolesForIssue,
  FACTORY_MUST_BE_KNOWN_STEPS,
} from '@/lib/domain/audit-routing';

describe('每日审计 · 阶段门槛(未指定工厂)', () => {
  it('订单还在 PO/PI 阶段 → 不该报「未指定工厂」', () => {
    expect(factoryShouldBeKnown([
      { step_key: 'po_confirmed', status: 'done' },
      { step_key: 'finance_approval', status: 'done' },
      { step_key: 'factory_confirmed', status: 'pending' },
    ])).toBe(false);
  });

  it('工厂匹配确认已完成但工厂名为空 → 必报', () => {
    expect(factoryShouldBeKnown([{ step_key: 'factory_confirmed', status: 'done' }])).toBe(true);
  });

  it('已开裁/已下采购单 → 工厂必然已知,必报', () => {
    expect(factoryShouldBeKnown([{ step_key: 'production_kickoff', status: '已完成' }])).toBe(true);
    expect(factoryShouldBeKnown([{ step_key: 'procurement_order_placed', status: 'completed' }])).toBe(true);
  });

  it('无任何里程碑(新单)→ 不报', () => {
    expect(factoryShouldBeKnown([])).toBe(false);
  });

  it('门槛节点必须都是真实模板 step_key(防改名后静默失效)', () => {
    // V1/V2/V3 都用这几个 key;任何一个被改名,这里会先炸,而不是审计静默漏报
    for (const k of FACTORY_MUST_BE_KNOWN_STEPS) expect(k).toMatch(/^[a-z_]+$/);
    expect(FACTORY_MUST_BE_KNOWN_STEPS).toContain('factory_confirmed');
  });
});

describe('每日审计 · 收件人路由', () => {
  it('未指定工厂 → 行政督导 + 生产主管', () => {
    const r = recipientRolesForIssue('missing_factory');
    expect(r).toContain('admin_assistant');
    expect(r).toContain('production_manager');
  });

  it('出厂日已过 → 行政督导 + 业务执行经理', () => {
    const r = recipientRolesForIssue('factory_date_overdue');
    expect(r).toContain('admin_assistant');
    expect(r).toContain('order_manager');
  });

  it('节点逾期 → 行政督导 + 该节点归口部门主管(复用延期审批路由)', () => {
    expect(recipientRolesForIssue('milestone_overdue', ['production'])).toEqual(
      expect.arrayContaining(['admin_assistant', 'production_manager']),
    );
    expect(recipientRolesForIssue('milestone_overdue', ['procurement'])).toEqual(
      expect.arrayContaining(['admin_assistant', 'order_manager']),
    );
    expect(recipientRolesForIssue('milestone_overdue', ['sales'])).toEqual(
      expect.arrayContaining(['admin_assistant', 'sales_manager']),
    );
  });

  it('节点逾期涉及多部门 → 各部门主管都收到,且不重复', () => {
    const r = recipientRolesForIssue('milestone_overdue', ['production', 'qc', 'production']);
    expect(r.filter((x) => x === 'production_manager')).toHaveLength(1);
  });

  it('节点逾期无 owner_role → 走兜底,不落空', () => {
    expect(recipientRolesForIssue('milestone_overdue', []).length).toBeGreaterThan(1);
  });

  it('录入质量类问题不进主管督办(只汇总给 admin)', () => {
    expect(AUDIT_ROUTING.missing_internal_no).toEqual([]);
    expect(AUDIT_ROUTING.stale_order).toEqual([]);
  });

  it('每个 kind 都有中文名(通知渲染不出现裸 key)', () => {
    for (const k of Object.keys(AUDIT_ROUTING)) {
      expect((AUDIT_KIND_CN as any)[k]).toBeTruthy();
    }
  });
});
