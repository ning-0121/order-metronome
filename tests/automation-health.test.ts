/**
 * R1-B Automation Outcome Health Layer —— 钉死核心口径:
 * A JOB IS NOT HEALTHY BECAUSE IT RAN. 健康由业务产出判定,不是 HTTP 200。
 *
 * 这些规则是 CEO 在 R1-B 里定死的,"优化"它们必须先过这组测试。
 */

import { describe, it, expect } from 'vitest';
import { computeJobHealth, notifyAutomationHealth } from '@/lib/automation/run-job';
import { evaluateWatchRules, WATCH_RULES } from '@/lib/automation/watchdog';

describe('computeJobHealth:业务成功 ≠ 技术成功', () => {
  it('eligible>0 且 processed=0 → failed/critical(该干的活一件没干)', () => {
    const v = computeJobHealth({ eligible: 7, processed: 0 });
    expect(v.status).toBe('failed');
    expect(v.health).toBe('critical');
  });

  it('eligible=0 且 processed=0 → healthy + no_work(没活干是正常,不能混同失败)', () => {
    const v = computeJobHealth({ eligible: 0, processed: 0 });
    expect(v.status).toBe('success');
    expect(v.health).toBe('healthy');
    expect(v.reasons[0]).toContain('no_work');
  });

  it('部分失败 → degraded/warning', () => {
    const v = computeJobHealth({ eligible: 7, processed: 5, failedItems: 2 });
    expect(v.status).toBe('degraded');
    expect(v.health).toBe('warning');
  });

  it('关键步骤 DB error → failed(不是 degraded)', () => {
    const v = computeJobHealth({ steps: [{ step: 'customer_rhythm', critical: true, error: 'permission denied' }] });
    expect(v.status).toBe('failed');
  });

  it('非关键步骤失败 → degraded,不拖垮整个 job', () => {
    const v = computeJobHealth({ steps: [{ step: 'stale_alerts', error: 'x' }], eligible: 5, processed: 5 });
    expect(v.status).toBe('degraded');
  });

  it('步骤 silent-zero(eligible>0 产出0)→ 至少 degraded', () => {
    const v = computeJobHealth({ steps: [{ step: 'daily_tasks', critical: true, eligible: 12, written: 0 }] });
    expect(['degraded', 'failed']).toContain(v.status);
    expect(v.reasons.join()).toContain('silent-zero');
  });

  it('显式 errorCode → failed', () => {
    expect(computeJobHealth({ errorCode: 'ZERO_ORDERS', errorMessage: 'x' }).status).toBe('failed');
  });
});

describe('watchdog:抓沉默和零产出', () => {
  const now = new Date('2026-08-08T12:00:00Z');
  const runAt = (hoursAgo: number, extra: any = {}) => ({
    started_at: new Date(now.getTime() - hoursAgo * 3600_000).toISOString(), status: 'success', ...extra,
  });

  it('故意构造 30 小时沉默 → critical', () => {
    const latest = new Map([['backup', { lastOk: runAt(30, { artifacts_created: 1 }), lastAny: runAt(30) }]]);
    const f = evaluateWatchRules(WATCH_RULES.filter((r) => r.job === 'backup'), latest, now);
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('critical');
    expect(f[0].reason).toContain('小时无达标运行');
  });

  it('从未运行过 → critical', () => {
    const latest = new Map([['daily', { lastOk: null, lastAny: null }]]);
    const f = evaluateWatchRules(WATCH_RULES.filter((r) => r.job === 'daily'), latest, now);
    expect(f[0].severity).toBe('critical');
  });

  it('备份跑了但零产物 → 违规', () => {
    const latest = new Map([['backup', { lastOk: runAt(2, { artifacts_created: 0 }), lastAny: runAt(2) }]]);
    const f = evaluateWatchRules(WATCH_RULES.filter((r) => r.job === 'backup'), latest, now);
    expect(f[0].reason).toContain('artifacts_created=0');
  });

  it('order-audit 有命中但通知 0 且非去重命中 → 违规;去重命中不违规', () => {
    const bad = new Map([['order-audit', { lastOk: runAt(2, { metadata: { audit_hits: 9, notifications_created: 0 } }), lastAny: runAt(2) }]]);
    expect(evaluateWatchRules(WATCH_RULES.filter((r) => r.job === 'order-audit'), bad, now)).toHaveLength(1);
    const ok = new Map([['order-audit', { lastOk: runAt(2, { metadata: { audit_hits: 9, notifications_created: 0, dedupe_hit: true } }), lastAny: runAt(2) }]]);
    expect(evaluateWatchRules(WATCH_RULES.filter((r) => r.job === 'order-audit'), ok, now)).toHaveLength(0);
  });

  it('briefing 有 eligible 但 generated=0 → 违规', () => {
    const latest = new Map([['daily-briefing', { lastOk: runAt(2, { eligible_items: 7, processed_items: 0 }), lastAny: runAt(2) }]]);
    const f = evaluateWatchRules(WATCH_RULES.filter((r) => r.job === 'daily-briefing'), latest, now);
    expect(f[0].reason).toContain('generated=0');
  });

  it('重试后仍失败(二连败)→ critical', () => {
    const latest = new Map([['daily', { lastOk: runAt(3), lastAny: { ...runAt(1), status: 'failed', retry_of_run_id: 'x' } }]]);
    const f = evaluateWatchRules(WATCH_RULES.filter((r) => r.job === 'daily'), latest, now);
    expect(f.some((x) => x.reason.includes('连续 2 次'))).toBe(true);
  });

  it('一切正常 → 零违规', () => {
    const latest = new Map([
      ['backup', { lastOk: runAt(2, { artifacts_created: 1 }), lastAny: runAt(2) }],
      ['daily', { lastOk: runAt(2, { metadata: { steps: [] } }), lastAny: runAt(2) }],
      ['order-audit', { lastOk: runAt(2, { metadata: { audit_hits: 0, notifications_created: 0 } }), lastAny: runAt(2) }],
      ['daily-briefing', { lastOk: runAt(2, { eligible_items: 7, processed_items: 7 }), lastAny: runAt(2) }],
      // reminders 每15分钟跑,maxSilenceHours=2 → 用 1h 前的健康运行(无关键步骤失败)
      ['reminders', { lastOk: runAt(1, { metadata: { steps: [] } }), lastAny: runAt(1) }],
    ]);
    expect(evaluateWatchRules(WATCH_RULES, latest, now)).toHaveLength(0);
  });
});

describe('告警去重:防通知风暴', () => {
  const mk = (dupExists: boolean) => {
    const inserted: any[] = [];
    const svc: any = {
      from(table: string) {
        if (table === 'notifications') {
          return {
            select() { return this; }, eq() { return this; }, ilike() { return this; }, gte() { return this; },
            limit: async () => ({ data: dupExists ? [{ id: 'x' }] : [], error: null }),
          };
        }
        return { select() { return this; }, or: async () => ({ data: [{ user_id: 'a1' }], error: null }) };
      },
    };
    return { svc, inserted };
  };

  it('冷却窗内同指纹 → 合并不重发', async () => {
    const { svc } = mk(true);
    expect(await notifyAutomationHealth(svc, 'daily', 'critical', 'zero-output', 'x')).toBe(0);
  });

  it('healthy 不发任何告警', async () => {
    const { svc } = mk(false);
    expect(await notifyAutomationHealth(svc, 'daily', 'healthy', 'x', 'x')).toBe(0);
  });
});
