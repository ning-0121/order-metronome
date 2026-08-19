/**
 * 逾期判定 —— 全站唯一口径(2026-08-19)。
 *
 * 建这一层的原因:审计实测同一时刻同一批订单,三处给出三个答案。
 *   ① app/dashboard/page.tsx      SQL `.lt('due_at', 今天T00:00)` + lifecycle 过滤 → 217 个节点
 *   ② lib/domain/overdue-attribution.ts `isOverdue(m, now)` 纯 due_at < now(连当天 0 点都不是)
 *   ③ lib/services/ceo-cockpit.service.ts 在 ① 之上再叠 滚动排期/待收尾/延期待批/排除打样 → 107 个节点
 * 差 51%,而且方向是反的:**一线看到的逾期压力是管理层的两倍** ——
 * 责任人被 217 个红点追着,其中 108 个按滚动排期根本还没轮到他做。
 * (2026-07-28 已经因为同类分叉出过一次事故,当时只对齐了订单 lifecycle 名单,豁免层没对齐。)
 *
 * 本模块是纯函数,不碰 IO:调用方把「事实」查好传进来,这里只做判定。
 * 谁再加豁免,加在这里,三处自动同步。
 */

/** 不产生逾期的订单生命周期 = 已终结 ∪ 尚未激活(草稿/待审批/暂停,还没真正开跑)。 */
export const NO_OVERDUE_LIFECYCLE = new Set([
  'completed', '已完成', 'cancelled', '已取消', 'archived', '已归档', '已复盘',
  'draft', 'pending_approval', 'paused',
]);

const DONE = new Set(['done', '已完成', 'completed']);
const isDone = (s: unknown) => DONE.has(String(s ?? '').toLowerCase()) || DONE.has(String(s ?? ''));

export interface OverdueMilestone {
  id: string;
  order_id: string;
  step_key?: string | null;
  status?: string | null;
  due_at?: string | null;
}

/** 节点不算逾期时的原因。null = 确实逾期。用于 UI 解释「为什么这条不红」。 */
export type OverdueExemption =
  | 'DONE'                 // 已完成
  | 'NO_DUE'               // 没有截止日
  | 'NOT_YET_DUE'          // 还没到期
  | 'ORDER_NOT_ACTIVE'     // 订单已终结/尚未激活
  | 'SAMPLE_ORDER'         // 打样单(不进部门健康/员工准时率口径)
  | 'DELAY_PENDING'        // 已申请延期待批 —— 责任人已行动
  | 'ORDER_STALE'          // 待收尾单(出厂日已过 + 长期无人点节点),另立一栏
  | 'WAITING_PREREQ'       // 滚动排期:前置未完成,还没轮到他做
  | null;

export interface OverdueContext {
  nowMs: number;
  /** 订单 id → 订单事实。缺失视为「订单不可判定」→ 不算逾期(宁可少报,不冤枉人)。 */
  orderById: Map<string, { lifecycle_status?: string | null; order_purpose?: string | null }>;
  /** 已申请延期待批的 milestone id。 */
  pendingDelayMilestoneIds?: Set<string> | null;
  /** 待收尾单 order id(出厂日已过 + N 天没有任何节点被点完成)。 */
  staleOrderIds?: Set<string> | null;
  /** 滚动排期结果,key = `${order_id}:${step_key}`。传 null = 不启用滚动口径,退回锚点 due_at。 */
  rollingSchedule?: Map<string, { overdue: boolean; rollingDue?: Date | null }> | null;
  /** 是否把打样单排除在外(部门健康/员工准时率口径为 true;个人待办为 false)。 */
  excludeSampleOrders?: boolean;
}

/**
 * 判定单个节点是否逾期,并给出「不算逾期」的原因。
 *
 * ⚠️ 时间基准:与 due_at 比较用 `nowMs` 当前时刻,不是「今天 0 点」。
 *    此前 dashboard 用当天 0 点、归属层用当前时刻,同一个节点在两处一红一不红。
 */
export function evaluateOverdue(m: OverdueMilestone, ctx: OverdueContext): OverdueExemption {
  if (isDone(m.status)) return 'DONE';
  if (!m.due_at) return 'NO_DUE';

  const order = ctx.orderById.get(m.order_id);
  const lc = String(order?.lifecycle_status ?? '').toLowerCase();
  if (!order || NO_OVERDUE_LIFECYCLE.has(lc) || NO_OVERDUE_LIFECYCLE.has(String(order?.lifecycle_status ?? ''))) {
    return 'ORDER_NOT_ACTIVE';
  }
  if (ctx.excludeSampleOrders && String(order?.order_purpose ?? '') === 'sample') return 'SAMPLE_ORDER';

  // 责任人已申请延期 → 已行动,不再压在他头上(与首页/驾驶舱历来一致)
  if (ctx.pendingDelayMilestoneIds?.has(m.id)) return 'DELAY_PENDING';
  // 待收尾单:货多半已出、只是没人回来维护节拍器;单独进 staleOrders 一栏,不淹没真正要盯的
  if (ctx.staleOrderIds?.has(m.order_id)) return 'ORDER_STALE';

  // 滚动排期口径:前置没完成的节点 = waiting,不算他逾期(根治「客户拖上游、下游假逾期」)
  if (ctx.rollingSchedule) {
    const sched = ctx.rollingSchedule.get(`${m.order_id}:${m.step_key ?? ''}`);
    return sched?.overdue ? null : 'WAITING_PREREQ';
  }

  return new Date(m.due_at).getTime() < ctx.nowMs ? null : 'NOT_YET_DUE';
}

/** 是否逾期(evaluateOverdue 的布尔糖)。 */
export function isMilestoneOverdue(m: OverdueMilestone, ctx: OverdueContext): boolean {
  return evaluateOverdue(m, ctx) === null;
}

/** 逾期天数。滚动口径下按 rollingDue 算,否则按 due_at。 */
export function overdueDays(m: OverdueMilestone, ctx: OverdueContext): number {
  if (ctx.rollingSchedule) {
    const rd = ctx.rollingSchedule.get(`${m.order_id}:${m.step_key ?? ''}`)?.rollingDue;
    return rd ? Math.max(0, Math.floor((ctx.nowMs - rd.getTime()) / 86400000)) : 0;
  }
  return m.due_at ? Math.max(0, Math.floor((ctx.nowMs - new Date(m.due_at).getTime()) / 86400000)) : 0;
}

/**
 * 待收尾单判定(出厂日已过 + 连续 N 天没有任何节点被点完成)。
 *
 * ⚠️ 判活跃必须用 actual_at(节点真被点完成的时刻),**不能用 updated_at** ——
 *    后者会被批量维护(改负责人、补倍率)刷新,看上去人人都在动。
 */
export function deriveStaleOrderIds(
  orders: Array<{ id: string; factory_date?: string | null }>,
  milestones: Array<{ order_id: string; actual_at?: string | null }>,
  nowMs: number,
  idleDays = 14,
): Set<string> {
  const lastActive = new Map<string, number>();
  for (const m of milestones) {
    const t = m.actual_at ? new Date(m.actual_at).getTime() : 0;
    if (t > (lastActive.get(m.order_id) ?? 0)) lastActive.set(m.order_id, t);
  }
  const out = new Set<string>();
  for (const o of orders) {
    const fd = o.factory_date ? String(o.factory_date).slice(0, 10) : null;
    if (!fd) continue;
    if (new Date(fd + 'T23:59:59').getTime() >= nowMs) continue;   // 出厂日还没到 → 正常在途
    const last = lastActive.get(o.id) ?? 0;
    const idle = last ? Math.floor((nowMs - last) / 86400000) : Infinity;   // 从没点过 → 最不活跃
    if (idle > idleDays) out.add(o.id);
  }
  return out;
}
