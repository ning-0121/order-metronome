/**
 * 订单「进行中 / 已完成 / 已取消」的分组口径 —— 单一真相源(2026-07-30)。
 *
 * 为什么单独抽出来:这条规则本来内联在 app/orders/page.tsx 里,而"完成"在本系统里
 * 至少有三处各自的定义(订单中心 / 生产中心阶段机 / 分析页),互相对不上是反复出现的报障。
 * 抽到这里至少让它**可测、可被引用**,新代码别再内联抄一份。
 *
 * 关键修正:**取消 ≠ 完成**。
 * 改之前订单中心把 cancelled/已取消 也算进「已完成」→ 13 张客户砍掉的单被计成完成,
 * 完成率虚高、复盘失真。拆开后与生产中心的「历史完成」精确对上(实测 77 === 77)。
 */

export type OrderGroup = 'active' | 'completed' | 'cancelled';

/** lifecycle_status 里代表「不用再推进了」的值(完成 + 取消) */
export const DONE_LIFECYCLE = new Set(['completed', 'cancelled', '已完成', '已取消']);
/** lifecycle_status 里代表「已取消」的值 */
export const CANCELLED_LIFECYCLE = new Set(['cancelled', '已取消']);

const DONE_MILESTONE = new Set(['done', 'completed', '已完成', 'skipped', '已跳过']);

export function isMilestoneDone(status: unknown): boolean {
  return DONE_MILESTONE.has(String(status ?? ''));
}

/**
 * 判断一张订单该归到哪一组。
 *
 * @param order       至少要有 lifecycle_status
 * @param milestones  该单的里程碑(可空)。全部完成也算「已完成」——
 *                    覆盖"活儿其实干完了、只是没人去点 lifecycle 关单"的情况。
 */
export function classifyOrderGroup(
  order: { lifecycle_status?: string | null },
  milestones?: Array<{ status?: string | null }> | null,
): OrderGroup {
  const ls = String(order?.lifecycle_status || '');
  // 取消优先判:取消掉的单即便节点碰巧都完成了,也不能算交付
  if (CANCELLED_LIFECYCLE.has(ls)) return 'cancelled';
  if (DONE_LIFECYCLE.has(ls)) return 'completed';
  const ms = milestones || [];
  if (ms.length > 0 && ms.every((m) => isMilestoneDone(m?.status))) return 'completed';
  return 'active';
}
