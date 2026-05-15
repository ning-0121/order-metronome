/**
 * Lifecycle Status — 订单生命周期状态 SSOT
 *
 * 历史问题（2026-04-27 之前）：
 *   orders.lifecycle_status 字段在不同写入方混用了英文和中文枚举：
 *     - OverdueOrderGate 早期版本写中文 '已完成'
 *     - finance-callback / 人工 SQL 也写过中文 '已取消'
 *     - 业务代码后续才统一英文 'completed' / 'cancelled' / 'archived'
 *
 * 导致 bug：多处 filter 只过滤一种枚举（如只过滤英文），让中文枚举的订单
 *   "泄露"到不该出现的视图（如逾期任务、利润预警、风险订单页），同时
 *   修改保护 (checkOrderModifiable) 又能识别中文 → 业务想改改不了。
 *
 * 修复（2026-05-15）：本文件作为唯一事实来源，所有 lifecycle_status 过滤
 *   必须用此处导出的常量/helper，禁止内联字符串列表。
 *
 * 数据归一化：同期会跑一个 one-shot 迁移把中文值改成英文。
 *   见 supabase/migrations/20260515_normalize_lifecycle_status.sql
 */

/**
 * 终止态 — 订单已经走完生命周期，不应出现在「进行中」视图
 * 包含中英文枚举（防御性，迁移完成后仍保留以防新数据漂回）
 */
export const TERMINAL_LIFECYCLE_STATUSES = [
  'completed',
  'cancelled',
  'archived',
  '已完成',
  '已取消',
  '已归档',
] as const;

/**
 * 已完成态（包含 archived，因为 archived 通常是 completed → 归档的延伸）
 * 用于"该订单已经收尾，不允许修改"判断
 */
export const DONE_LIFECYCLE_STATUSES = [
  'completed',
  'archived',
  '已完成',
  '已归档',
] as const;

/**
 * 已取消态
 */
export const CANCELLED_LIFECYCLE_STATUSES = [
  'cancelled',
  '已取消',
] as const;

/**
 * 给 Supabase `.in()` / `.not('...', 'in', ...)` 用的字符串
 * 注意：Supabase REST 的 IN filter 不接受数组，必须是 '("a","b","c")' 格式
 */
export const TERMINAL_LIFECYCLE_FILTER = '("completed","cancelled","archived","已完成","已取消","已归档")';

/**
 * 判断 lifecycle_status 是否为终止态
 * @param status 来自 orders.lifecycle_status
 */
export function isTerminalLifecycle(status: string | null | undefined): boolean {
  if (!status) return false;
  return (TERMINAL_LIFECYCLE_STATUSES as readonly string[]).includes(status);
}

/**
 * 判断是否为已完成（不含 cancelled）
 */
export function isDoneLifecycle(status: string | null | undefined): boolean {
  if (!status) return false;
  return (DONE_LIFECYCLE_STATUSES as readonly string[]).includes(status);
}

/**
 * 判断是否为已取消
 */
export function isCancelledLifecycle(status: string | null | undefined): boolean {
  if (!status) return false;
  return (CANCELLED_LIFECYCLE_STATUSES as readonly string[]).includes(status);
}

/**
 * 把任意中文/英文 lifecycle_status 归一化为英文枚举
 * 未识别的值原样返回（不抛错，让上层决定）
 *
 * 注意：这个函数仅用于 UI 展示统一化，**不要在写入数据库前用此函数自动转换**，
 *      因为可能掩盖了上游 bug（应当从源头修复，不是在 UI 兜底）。
 *      数据库一次性归一化用迁移脚本，不用这个函数。
 */
export function normalizeLifecycleStatus(status: string | null | undefined): string | null {
  if (!status) return null;
  const map: Record<string, string> = {
    '已完成': 'completed',
    '已取消': 'cancelled',
    '已归档': 'archived',
  };
  return map[status] ?? status;
}
