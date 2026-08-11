/**
 * 滚动排期(混合方案)—— CEO 2026-08-10。
 *
 * 【痛点】老引擎纯锚点逆排:所有节点截止日绑死交期锚点(出厂日/ETD)。上游被客户拖一下,
 * 下游跟单/采购节点的截止日不动 → 立刻显示逾期,可它们根本还没法开始。假逾期淹没真风险。
 *
 * 【混合方案】两个信号分开:
 *  1) 节点逾期(本模块,滚动):节点的【前置节点】没全部完成前 → 不显示截止日、不算逾期;
 *     前置一旦完成(完成日 D)→ 该节点截止日 = D + 该段允许天数 N(N 取自 TIMELINE 相邻差值,按工作日)。
 *  2) 交付风险(不在本模块,仍走锚点):runtime 置信引擎照 出厂日 逆排投影,要冲破船期单独报警。
 *
 * 【纯函数】不碰数据库、不改存量 due_at;读时派生。上层用 rollingScheduleActive() 决定用不用。
 *
 * 依赖图 SEQUENTIAL_REQUIREMENTS 是 V3 单一真相(app/actions/milestones.ts 的硬前置从这里 import);
 * 非 V3 单(V1/V2/trade/sample)没有显式依赖图 → 按 sequence_number 线性前置(前一个 seq 节点完成才算可开始)。
 */

import { TIMELINE } from '@/lib/schedule';

/** V3 硬前置依赖图 —— 单一真相(milestones.ts 的顺序门禁 import 此表)。 */
export const SEQUENTIAL_REQUIREMENTS_V3: Record<string, string[]> = {
  finance_approval: ['po_confirmed'],
  pi_confirmed: ['po_confirmed'],
  production_order_upload: ['pi_confirmed'],
  order_kickoff_meeting: ['production_order_upload'],
  procurement_order_placed: ['finance_approval', 'order_kickoff_meeting'],
  pre_production_sample_sent: ['procurement_order_placed'],
  pps_procurement_check: ['pre_production_sample_sent'],
  pre_production_sample_approved: ['pps_procurement_check'],
  initial_line_check: ['pre_production_sample_approved'],
  mid_qc_check: ['initial_line_check'],
  packing_method_confirmed: ['pre_production_sample_approved'],
  final_qc_check: ['mid_qc_check', 'packing_method_confirmed'],
  final_qc_sales_check: ['final_qc_check'],
  shipping_sample_send: ['final_qc_sales_check'],
  ci_made: ['final_qc_sales_check'],
  booking_done: ['ci_made'],
  shipment_execute: ['booking_done', 'ci_made'],
  payment_received: ['shipment_execute'],
};

const DONE = new Set(['done', '已完成', 'completed']);
const DAY = 86400000;

export function isDone(status: string | null | undefined): boolean {
  return DONE.has(String(status || '').toLowerCase());
}

export interface RSMilestone {
  step_key: string;
  status: string | null;
  actual_at?: string | null;
  due_at?: string | null;
  sequence_number?: number | null;
}

export type NodeScheduleState = 'done' | 'actionable' | 'waiting';

export interface NodeSchedule {
  step_key: string;
  state: NodeScheduleState;    // done=已完成 / actionable=前置齐可开始 / waiting=等上游
  rollingDue: Date | null;     // 仅 actionable 有;waiting=null(不显示截止日)
  overdue: boolean;            // 仅 actionable 且 rollingDue < now 才 true
  readyDate: Date | null;      // 前置最晚完成日(或订单起点)
}

/** 工作日加天(简化:跳周末;节假日精度交给 lib/utils/date,聚合口径用简化版足够) */
function addBusinessDays(base: Date, n: number): Date {
  const d = new Date(base);
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const bjDow = new Date(d.getTime() + 8 * 3600 * 1000).getUTCDay();
    if (bjDow !== 0 && bjDow !== 6) added++;
  }
  return d;
}

/** 某节点相对其前置的允许天数 N = TIMELINE[node] - max(TIMELINE[前置]);缺失兜底 2 天,至少 1 天。 */
export function allottedDays(stepKey: string, prereqs: string[]): number {
  const tl = TIMELINE as Record<string, number>;
  const self = tl[stepKey];
  if (self == null) return 2;
  if (!prereqs.length) return Math.max(1, self); // 无前置:从订单起点算
  const prereqDay = Math.max(...prereqs.map((p) => tl[p] ?? 0));
  return Math.max(1, self - prereqDay);
}

/** 取节点的前置集合:V3 用依赖图;非 V3 用 sequence 线性(前一个 seq 节点)。 */
function prereqsOf(stepKey: string, isV3: boolean, linearPrevByStep: Map<string, string>): string[] {
  if (isV3) return SEQUENTIAL_REQUIREMENTS_V3[stepKey] || [];
  const prev = linearPrevByStep.get(stepKey);
  return prev ? [prev] : [];
}

/**
 * 派生一个订单每个节点的滚动排期状态。
 * @param milestones 该订单全部节点(需带 step_key/status/actual_at/sequence_number)
 * @param opts.isV3 是否 V3(决定用依赖图还是线性前置)
 * @param opts.orderStartMs 订单起点(下单日/建单日)ms —— 无前置节点从此算
 * @param opts.nowMs 当前时间 ms
 */
export function deriveRollingSchedule(
  milestones: RSMilestone[],
  opts: { isV3: boolean; orderStartMs: number; nowMs: number },
): Map<string, NodeSchedule> {
  const { isV3, orderStartMs, nowMs } = opts;
  const out = new Map<string, NodeSchedule>();

  // 完成日查表:step_key → actual_at ms(缺 actual_at 的已完成节点兜底用 orderStart,避免 NaN)
  const doneAt = new Map<string, number>();
  for (const m of milestones) {
    if (isDone(m.status)) {
      const t = m.actual_at ? new Date(m.actual_at).getTime() : orderStartMs;
      doneAt.set(m.step_key, Number.isFinite(t) ? t : orderStartMs);
    }
  }

  // 非 V3:按 sequence 建线性前置表
  const linearPrevByStep = new Map<string, string>();
  if (!isV3) {
    const ordered = milestones
      .filter((m) => typeof m.sequence_number === 'number')
      .sort((a, b) => (a.sequence_number! - b.sequence_number!));
    for (let i = 1; i < ordered.length; i++) {
      linearPrevByStep.set(ordered[i].step_key, ordered[i - 1].step_key);
    }
  }

  for (const m of milestones) {
    if (isDone(m.status)) {
      out.set(m.step_key, { step_key: m.step_key, state: 'done', rollingDue: null, overdue: false, readyDate: null });
      continue;
    }
    const prereqs = prereqsOf(m.step_key, isV3, linearPrevByStep);
    const allDone = prereqs.every((p) => doneAt.has(p));
    if (prereqs.length > 0 && !allDone) {
      // 等上游 —— 不显示截止日、不算逾期(混合方案核心)
      out.set(m.step_key, { step_key: m.step_key, state: 'waiting', rollingDue: null, overdue: false, readyDate: null });
      continue;
    }
    // 可开始:readyDate = 前置最晚完成日(无前置=订单起点)
    const readyMs = prereqs.length ? Math.max(...prereqs.map((p) => doneAt.get(p)!)) : orderStartMs;
    const readyDate = new Date(readyMs);
    const rollingDue = addBusinessDays(readyDate, allottedDays(m.step_key, prereqs));
    out.set(m.step_key, {
      step_key: m.step_key,
      state: 'actionable',
      rollingDue,
      overdue: rollingDue.getTime() < nowMs,
      readyDate,
    });
  }
  return out;
}

/** 便捷:该订单当前「真逾期」的 step_key 集合(仅可开始且已过滚动截止日的)。 */
export function rollingOverdueSteps(
  milestones: RSMilestone[],
  opts: { isV3: boolean; orderStartMs: number; nowMs: number },
): Set<string> {
  const sched = deriveRollingSchedule(milestones, opts);
  const s = new Set<string>();
  for (const [k, v] of sched) if (v.overdue) s.add(k);
  return s;
}
