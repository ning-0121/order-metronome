/**
 * 僵尸订单分诊(2026-08-04,CEO 要求)。
 *
 * CEO 原话:
 *   「历史的逾期,已经出货了或者已经解决了,但是一直显示在这里,影响了判断的敏锐度,
 *     系统就没有预警意义了。」
 *   「这些出厂日期已过的,要显示在督办总览里,让行政督办能看到、去督办。」
 *   「每天早上系统过一遍这样的订单……有疑问的安排给行政督办来摸清实际情况进行反馈。」
 *
 * 实测(2026-08-04):372 个在算的逾期节点里,**164 个(44%)** 落在
 * 「出厂日已过 + 14 天没有任何节点被点完成」的 21 张单上。这些绝大多数是货已出、
 * 只是没人回来维护节拍器 —— 它们把真正要盯的那 33% 淹掉了,预警就失去意义。
 *
 * 分诊的意义在于:**这两类要给不同的人、做不同的事**
 *   · 疑似已出货没维护 → 不是催责任人,是让行政督办去**核实实际情况**,再一键收尾
 *   · 真晚了还在推     → 催责任人推进度
 * 混在一个「逾期」数字里,两件事都做不好。
 *
 * ⚠️ 判活跃只能用 milestones.actual_at(节点真被点完成的时刻)。
 *    **不能用 updated_at** —— 批量维护(改负责人、补套装倍率等)会刷新它,
 *    2026-08-04 我第一版就是用 updated_at,算出「95% 都在活跃」的假象。
 */

export type StaleVerdict =
  | 'suspected_shipped'   // 出厂日已过 + 长期无人推进 → 派行政督办核实实际情况
  | 'stalled'             // 出厂日已过但近期有人在推 → 真晚了,催责任人
  | 'at_risk'             // 出厂日未到但已有逾期节点 → 提前预警
  | 'healthy';

export interface TriageInput {
  factoryDate: string | null;          // orders.factory_date
  /** 该单所有节点的 actual_at(已完成才有值);传全量,内部取最大 */
  actualAts: Array<string | null | undefined>;
  /** 该单当前逾期(未完成 + due_at 已过)的节点数 */
  overdueCount: number;
  now?: number;
}

export interface TriageResult {
  verdict: StaleVerdict;
  /** 出厂日已过天数;出厂日未到或缺失为 null */
  pastFactoryDays: number | null;
  /** 距最近一次「有节点被点完成」的天数;从没点过为 null */
  idleDays: number | null;
  /** 从建单起就没有任何节点被点完成过 —— 多半是补录的历史单 */
  neverTouched: boolean;
  overdueCount: number;
}

/** 出厂日已过多少天后才纳入分诊(当天/刚过一两天属正常波动,不惊动督办) */
export const PAST_FACTORY_GRACE_DAYS = 0;
/** 多少天没有任何节点被点完成,视为「没人在推」 */
export const STALE_IDLE_DAYS = 14;

const DAY = 86400000;

export function triageStaleOrder(input: TriageInput): TriageResult {
  const now = input.now ?? Date.now();

  // ⚠️ 天数算法必须与订单列表「出厂日已过」横幅一致(app/orders/page.tsx):
  //    以出厂日**当天 23:59:59** 为界 + Math.ceil。两处口径不同会出现同一张单
  //    这边显示「已过 37 天」、那边「已过 38 天」,看的人会怀疑数据。
  const pastFactoryDays = input.factoryDate
    ? Math.ceil((now - new Date(String(input.factoryDate).slice(0, 10) + 'T23:59:59').getTime()) / DAY)
    : null;

  const acts = (input.actualAts || [])
    .map((a) => (a ? new Date(a).getTime() : 0))
    .filter((t) => t > 0);
  const neverTouched = acts.length === 0;
  const idleDays = neverTouched ? null : Math.floor((now - Math.max(...acts)) / DAY);

  const base: Omit<TriageResult, 'verdict'> = {
    pastFactoryDays, idleDays, neverTouched, overdueCount: input.overdueCount,
  };

  const pastFactory = pastFactoryDays !== null && pastFactoryDays > PAST_FACTORY_GRACE_DAYS;
  // 从没点过任何节点 = 最不活跃,直接算「没人在推」(补录的历史单就是这个形态)
  const noOneWorkingIt = neverTouched || (idleDays !== null && idleDays > STALE_IDLE_DAYS);

  if (pastFactory && noOneWorkingIt) return { ...base, verdict: 'suspected_shipped' };
  if (pastFactory) return { ...base, verdict: 'stalled' };
  if (input.overdueCount > 0) return { ...base, verdict: 'at_risk' };
  return { ...base, verdict: 'healthy' };
}

/** 给人看的一句话,说明为什么进这一档、该干什么 */
export function explainVerdict(r: TriageResult): string {
  switch (r.verdict) {
    case 'suspected_shipped':
      return r.neverTouched
        ? `出厂日已过 ${r.pastFactoryDays} 天,且**从未点过任何节点** —— 多半是补录的历史单或货早已出。请核实实际情况后一键收尾。`
        : `出厂日已过 ${r.pastFactoryDays} 天,已 ${r.idleDays} 天没人点过任何节点 —— 疑似货已出没维护。请核实后一键收尾。`;
    case 'stalled':
      return `出厂日已过 ${r.pastFactoryDays} 天,近期仍有人在推(${r.idleDays} 天前有动作),${r.overdueCount} 个节点逾期。属真延误,请催责任人。`;
    case 'at_risk':
      return `出厂日未到,但已有 ${r.overdueCount} 个节点逾期,再拖会影响交期。`;
    default:
      return '正常';
  }
}
