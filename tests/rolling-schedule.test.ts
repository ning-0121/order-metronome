import { describe, it, expect } from 'vitest';
import { deriveRollingSchedule, rollingOverdueSteps, allottedDays, SEQUENTIAL_REQUIREMENTS_V3 } from '@/lib/schedule/rollingSchedule';

const DAY = 86400000;
const iso = (ms: number) => new Date(ms).toISOString();

// 固定"现在"避免 Date.now 抖动
const NOW = new Date('2026-08-10T00:00:00+08:00').getTime();
const START = new Date('2026-06-01T00:00:00+08:00').getTime();

function v3Order(overrides: Record<string, { status: string; actual_at?: string }>) {
  // 只列测试关心的几个节点
  const keys = ['po_confirmed', 'pi_confirmed', 'production_order_upload', 'finance_approval', 'order_kickoff_meeting', 'procurement_order_placed'];
  return keys.map((k, i) => ({
    step_key: k, sequence_number: i,
    status: overrides[k]?.status ?? 'pending',
    actual_at: overrides[k]?.actual_at ?? null,
    due_at: iso(START), // 故意给个很早的老 due_at,验证 waiting 不会因它变逾期
  }));
}

describe('rollingSchedule — 混合方案核心', () => {
  it('前置未完成的节点 = waiting,不显示截止日、不算逾期(即便老 due_at 早已过期)', () => {
    // PI 未确认 → production_order_upload 应 waiting
    const ms = v3Order({ po_confirmed: { status: 'done', actual_at: iso(START) } });
    const sched = deriveRollingSchedule(ms, { isV3: true, orderStartMs: START, nowMs: NOW });
    const pou = sched.get('production_order_upload')!;
    expect(pou.state).toBe('waiting');
    expect(pou.rollingDue).toBeNull();
    expect(pou.overdue).toBe(false); // 关键:客户拖 PI,下游不假逾期
  });

  it('前置刚完成 → 节点变 actionable,截止日 = 前置完成日 + N 工作日', () => {
    const piDone = NOW - 1 * DAY; // PI 昨天确认
    const ms = v3Order({
      po_confirmed: { status: 'done', actual_at: iso(START) },
      pi_confirmed: { status: 'done', actual_at: iso(piDone) },
    });
    const sched = deriveRollingSchedule(ms, { isV3: true, orderStartMs: START, nowMs: NOW });
    const pou = sched.get('production_order_upload')!;
    expect(pou.state).toBe('actionable');
    expect(pou.rollingDue).not.toBeNull();
    // production_order_upload(TL=3) 前置 pi_confirmed(TL=1) → N=2 工作日;PI 昨天完成 → 截止在未来 → 不逾期
    expect(pou.rollingDue!.getTime()).toBeGreaterThan(piDone);
    expect(pou.overdue).toBe(false);
  });

  it('可开始节点超过滚动截止日 → 真逾期', () => {
    const piDone = NOW - 30 * DAY; // PI 30 天前确认,pou 早该做完
    const ms = v3Order({
      po_confirmed: { status: 'done', actual_at: iso(START) },
      pi_confirmed: { status: 'done', actual_at: iso(piDone) },
    });
    const overdue = rollingOverdueSteps(ms, { isV3: true, orderStartMs: START, nowMs: NOW });
    expect(overdue.has('production_order_upload')).toBe(true); // 可开始且拖了30天=真逾期
  });

  it('多前置:procurement_order_placed 要 finance_approval + order_kickoff_meeting 都完成才 actionable', () => {
    const ms = v3Order({
      po_confirmed: { status: 'done', actual_at: iso(START) },
      pi_confirmed: { status: 'done', actual_at: iso(START) },
      production_order_upload: { status: 'done', actual_at: iso(START) },
      finance_approval: { status: 'done', actual_at: iso(START) },
      // order_kickoff_meeting 未完成
    });
    const sched = deriveRollingSchedule(ms, { isV3: true, orderStartMs: START, nowMs: NOW });
    expect(sched.get('procurement_order_placed')!.state).toBe('waiting');
    expect(sched.get('procurement_order_placed')!.overdue).toBe(false);
  });

  it('非 V3 单:按 sequence 线性前置', () => {
    const ms = [
      { step_key: 'a', sequence_number: 0, status: 'done', actual_at: iso(NOW - 40 * DAY) },
      { step_key: 'b', sequence_number: 1, status: 'pending', actual_at: null },
      { step_key: 'c', sequence_number: 2, status: 'pending', actual_at: null },
    ];
    const sched = deriveRollingSchedule(ms, { isV3: false, orderStartMs: START, nowMs: NOW });
    expect(sched.get('b')!.state).toBe('actionable'); // 前一个(a)完成 → 可开始
    expect(sched.get('c')!.state).toBe('waiting');    // b 未完成 → 等
    expect(sched.get('c')!.overdue).toBe(false);
  });

  it('allottedDays:有 TIMELINE 差值按差值,至少 1 天', () => {
    // production_order_upload(3) - pi_confirmed(1) = 2
    expect(allottedDays('production_order_upload', ['pi_confirmed'])).toBe(2);
    // 未知 key 兜底 2
    expect(allottedDays('__nonexistent__', ['pi_confirmed'])).toBe(2);
  });

  it('依赖图是单一真相(被 milestones.ts import)', () => {
    expect(SEQUENTIAL_REQUIREMENTS_V3.final_qc_check).toEqual(['mid_qc_check', 'packing_method_confirmed']);
  });
});
