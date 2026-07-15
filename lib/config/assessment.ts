/**
 * 考核启用基线(2026-07-14 用户拍板)。
 *
 * 规则:本周一(2026-07-13)起才纳入考核 —— 只考核 due_at ≥ 基线日 的节点
 *   (= 进行中订单的本周及以后节点 + 本周起新建订单的全部节点)。
 *   之前的节点不追溯,避免历史「实际做了但没在系统点完成」的存量把员工分砸没。
 *
 * 可用环境变量 ASSESSMENT_BASELINE_DATE 覆盖(改基线/整体重置无需改码、无需部署),
 *   格式 YYYY-MM-DD;不设则用默认基线。
 */
export const ASSESSMENT_BASELINE_DATE = process.env.ASSESSMENT_BASELINE_DATE || '2026-07-13';

/** 基线日 00:00(本地口径)。due_at < 此值的节点不计入逾期/响应等考核指标。 */
export function assessmentBaseline(): Date {
  return new Date(`${ASSESSMENT_BASELINE_DATE}T00:00:00`);
}

/**
 * 月度奖励额度(2026-07-14 用户拍板,元)。正向为主、人人够得着;改额度只改这里。
 *  - qualified:达标奖——月综合分 ≥75(A)且无红线,有产出;
 *  - rank:红榜 Top3(按执行分),仅有产出者;
 *  - fullAttendance:零逾期全勤奖——整月 0 红线、0 当前逾期,有产出。
 */
export const ASSESSMENT_AWARDS = {
  qualified: 200,
  rank: [300, 200, 100] as number[],
  fullAttendance: 100,
};
