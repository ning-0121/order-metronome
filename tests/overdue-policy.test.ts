import { describe, it, expect } from 'vitest';
import { evaluateOverdue, isMilestoneOverdue, overdueDays, deriveStaleOrderIds, type OverdueContext } from '@/lib/domain/overdue-policy';

/**
 * 逾期判定单一口径(2026-08-19)。
 *
 * 审计实测:同一时刻同一批订单,三处三个答案 —— 工作台 217 / 驾驶舱 107(差 51%),
 * 归属层还有第三套(纯 due_at < now)。方向是反的:一线看到的压力是管理层两倍,
 * 其中 108 个按滚动排期根本还没轮到责任人做。本模块把豁免层收成一份。
 */
const NOW = new Date('2026-08-19T10:00:00Z').getTime();
const ACTIVE = new Map([['o1', { lifecycle_status: 'active', order_purpose: 'production' }]]);
const base = (over: Partial<OverdueContext> = {}): OverdueContext =>
  ({ nowMs: NOW, orderById: ACTIVE as any, ...over });
const ms = (o: any = {}) => ({ id: 'm1', order_id: 'o1', step_key: 'po_confirmed', status: 'pending', due_at: '2026-08-10T00:00:00Z', ...o });

describe('逾期判定 · 单一口径', () => {
  it('过了 due_at 且未完成 → 逾期', () => {
    expect(evaluateOverdue(ms(), base())).toBeNull();
    expect(isMilestoneOverdue(ms(), base())).toBe(true);
  });

  it('已完成 / 无截止日 / 还没到期 → 各自给出原因,都不算逾期', () => {
    expect(evaluateOverdue(ms({ status: 'done' }), base())).toBe('DONE');
    expect(evaluateOverdue(ms({ due_at: null }), base())).toBe('NO_DUE');
    expect(evaluateOverdue(ms({ due_at: '2026-09-01T00:00:00Z' }), base())).toBe('NOT_YET_DUE');
  });

  it('订单已终结 / 尚未激活 → 不产生逾期(草稿单建出来就天天累计的老问题)', () => {
    for (const lc of ['completed', 'cancelled', 'draft', 'pending_approval', 'paused', '已取消']) {
      const ctx = base({ orderById: new Map([['o1', { lifecycle_status: lc }]]) as any });
      expect(evaluateOverdue(ms(), ctx)).toBe('ORDER_NOT_ACTIVE');
    }
  });

  it('订单查不到 → 不算逾期(宁可少报,不冤枉人)', () => {
    expect(evaluateOverdue(ms(), base({ orderById: new Map() as any }))).toBe('ORDER_NOT_ACTIVE');
  });

  it('⭐ 已申请延期待批 → 责任人已行动,不再算他逾期', () => {
    expect(evaluateOverdue(ms(), base({ pendingDelayMilestoneIds: new Set(['m1']) }))).toBe('DELAY_PENDING');
  });

  it('⭐ 待收尾单 → 不计入预警,另立一栏', () => {
    expect(evaluateOverdue(ms(), base({ staleOrderIds: new Set(['o1']) }))).toBe('ORDER_STALE');
  });

  it('⭐ 滚动排期判 waiting(前置未完成)→ 还没轮到他,不算逾期', () => {
    const roll = new Map([['o1:po_confirmed', { overdue: false }]]);
    expect(evaluateOverdue(ms(), base({ rollingSchedule: roll }))).toBe('WAITING_PREREQ');
    const roll2 = new Map([['o1:po_confirmed', { overdue: true }]]);
    expect(evaluateOverdue(ms(), base({ rollingSchedule: roll2 }))).toBeNull();
  });

  it('滚动口径下,即使 due_at 还没到,前置已完成也可能判逾期(滚动把 due 提前)', () => {
    const roll = new Map([['o1:po_confirmed', { overdue: true }]]);
    expect(evaluateOverdue(ms({ due_at: '2026-12-01T00:00:00Z' }), base({ rollingSchedule: roll }))).toBeNull();
  });

  it('打样单:只在开启 excludeSampleOrders 的口径里被排除', () => {
    const sample = new Map([['o1', { lifecycle_status: 'active', order_purpose: 'sample' }]]) as any;
    expect(evaluateOverdue(ms(), base({ orderById: sample }))).toBeNull();
    expect(evaluateOverdue(ms(), base({ orderById: sample, excludeSampleOrders: true }))).toBe('SAMPLE_ORDER');
  });

  it('豁免优先级:完成 > 订单态 > 延期待批 > 待收尾 > 滚动', () => {
    const ctx = base({ pendingDelayMilestoneIds: new Set(['m1']), staleOrderIds: new Set(['o1']),
      rollingSchedule: new Map([['o1:po_confirmed', { overdue: true }]]) });
    expect(evaluateOverdue(ms({ status: 'done' }), ctx)).toBe('DONE');
    expect(evaluateOverdue(ms(), ctx)).toBe('DELAY_PENDING');
  });

  it('逾期天数:滚动口径按 rollingDue,否则按 due_at', () => {
    expect(overdueDays(ms(), base())).toBe(9);   // 08-10 → 08-19
    const roll = new Map([['o1:po_confirmed', { overdue: true, rollingDue: new Date('2026-08-17T10:00:00Z') }]]);
    expect(overdueDays(ms(), base({ rollingSchedule: roll }))).toBe(2);
  });
});

describe('待收尾单判定', () => {
  const D = (s: string) => new Date(s).getTime();
  it('出厂日已过 + 超过 14 天没有节点被点完成 → stale', () => {
    const out = deriveStaleOrderIds(
      [{ id: 'o1', factory_date: '2026-07-01' }],
      [{ order_id: 'o1', actual_at: '2026-07-20T00:00:00Z' }], NOW);
    expect(out.has('o1')).toBe(true);
  });
  it('出厂日还没到 → 正常在途,不是 stale', () => {
    const out = deriveStaleOrderIds([{ id: 'o1', factory_date: '2026-12-01' }], [], NOW);
    expect(out.has('o1')).toBe(false);
  });
  it('最近有人点过节点 → 不是 stale', () => {
    const out = deriveStaleOrderIds(
      [{ id: 'o1', factory_date: '2026-07-01' }],
      [{ order_id: 'o1', actual_at: '2026-08-18T00:00:00Z' }], NOW);
    expect(out.has('o1')).toBe(false);
  });
  it('从没点过任何节点 + 出厂日已过 → stale(视为最不活跃)', () => {
    const out = deriveStaleOrderIds([{ id: 'o1', factory_date: '2026-07-01' }], [], NOW);
    expect(out.has('o1')).toBe(true);
  });
  it('无出厂日 → 不判 stale', () => {
    expect(deriveStaleOrderIds([{ id: 'o1', factory_date: null }], [], NOW).size).toBe(0);
  });
});
