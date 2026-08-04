/**
 * 僵尸订单分诊(2026-08-04)。
 *
 * 分诊要解决的是 CEO 提的「预警没有意义了」:372 个逾期节点里 44% 落在
 * 「出厂日已过 + 14 天没人点过任何节点」的单上,把真正要盯的淹掉了。
 *
 * 关键是**两类要分开**:疑似已出货没维护 → 派行政督办核实;真晚了还在推 → 催责任人。
 */
import { describe, it, expect } from 'vitest';
import { triageStaleOrder, explainVerdict, STALE_IDLE_DAYS } from '@/lib/services/stale-order-triage';

const NOW = new Date('2026-08-04T12:00:00Z').getTime();
const daysAgo = (n: number) => new Date(NOW - n * 86400000).toISOString();
const ymd = (n: number) => new Date(NOW - n * 86400000).toISOString().slice(0, 10);

describe('疑似已出货没维护 → 派行政督办核实', () => {
  it('出厂日已过 + 超过 14 天没人点节点', () => {
    const r = triageStaleOrder({ factoryDate: ymd(38), actualAts: [daysAgo(20)], overdueCount: 13, now: NOW });
    expect(r.verdict).toBe('suspected_shipped');
    expect(r.pastFactoryDays).toBe(38);
    expect(r.idleDays).toBe(20);
  });

  it('补录的历史单:出厂日在过去 + 从没点过任何节点(真实case 1022919)', () => {
    // 建单当天就 15 个逾期 —— 出厂日 7-25 在过去,所有节点 due_at 一出生就过期
    const r = triageStaleOrder({ factoryDate: ymd(9), actualAts: [], overdueCount: 15, now: NOW });
    expect(r.verdict).toBe('suspected_shipped');
    expect(r.neverTouched).toBe(true);
    expect(r.idleDays).toBeNull();
    expect(explainVerdict(r)).toContain('从未点过任何节点');
  });

  it('全是空的 actual_at 也算从没点过', () => {
    const r = triageStaleOrder({ factoryDate: ymd(5), actualAts: [null, undefined, ''], overdueCount: 3, now: NOW });
    expect(r.neverTouched).toBe(true);
    expect(r.verdict).toBe('suspected_shipped');
  });
});

describe('真晚了还在推 → 催责任人,别当僵尸单', () => {
  it('出厂日已过但两天前还有人点节点', () => {
    const r = triageStaleOrder({ factoryDate: ymd(10), actualAts: [daysAgo(2)], overdueCount: 4, now: NOW });
    expect(r.verdict).toBe('stalled');
    expect(explainVerdict(r)).toContain('催责任人');
  });

  it('刚好卡在 14 天边界上仍算在推(> 才算停)', () => {
    expect(triageStaleOrder({ factoryDate: ymd(10), actualAts: [daysAgo(STALE_IDLE_DAYS)], overdueCount: 1, now: NOW }).verdict).toBe('stalled');
    expect(triageStaleOrder({ factoryDate: ymd(10), actualAts: [daysAgo(STALE_IDLE_DAYS + 1)], overdueCount: 1, now: NOW }).verdict).toBe('suspected_shipped');
  });

  it('取最近一次动作,不是最早那次', () => {
    const r = triageStaleOrder({ factoryDate: ymd(30), actualAts: [daysAgo(90), daysAgo(60), daysAgo(3)], overdueCount: 2, now: NOW });
    expect(r.idleDays).toBe(3);
    expect(r.verdict).toBe('stalled');
  });
});

describe('出厂日未到', () => {
  it('有逾期节点 → at_risk(提前预警,不进督办僵尸区)', () => {
    expect(triageStaleOrder({ factoryDate: ymd(-20), actualAts: [daysAgo(1)], overdueCount: 2, now: NOW }).verdict).toBe('at_risk');
  });

  it('没有逾期 → healthy', () => {
    expect(triageStaleOrder({ factoryDate: ymd(-20), actualAts: [daysAgo(1)], overdueCount: 0, now: NOW }).verdict).toBe('healthy');
  });

  it('出厂日缺失时,只按有无逾期判,不能当僵尸单误伤', () => {
    expect(triageStaleOrder({ factoryDate: null, actualAts: [], overdueCount: 0, now: NOW }).verdict).toBe('healthy');
    expect(triageStaleOrder({ factoryDate: null, actualAts: [], overdueCount: 5, now: NOW }).verdict).toBe('at_risk');
  });
});
