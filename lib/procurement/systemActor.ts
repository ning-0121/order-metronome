// ============================================================
// System Actor Token —— 让「系统自动推进」与「人手工操作」在同一份算法上共存
//
// 问题:consolidateOrderProcurementItems 的角色闸是 procurement/procurement_manager/admin,
// 但 P0 要求**跟单提交 BOM 后系统自动归并** —— 跟单不是采购角色,直接调用必被拒。
//
// 为什么用 Symbol 而不是 opts.systemActor: true:
//   consolidateOrderProcurementItems 是 'use server' 导出,**浏览器可以直接调用并伪造任意 JSON 参数**。
//   布尔标志 = 任何登录用户都能跳过采购角色闸(提权)。
//   Symbol 不可序列化 —— 客户端无法通过 Server Action 参数传进来,只有同进程的服务端代码拿得到。
//
// 边界:它只跳过**角色闸**,不跳过登录校验、不换 service-role 客户端、不放宽 RLS。
// 系统计算(归并)可以自动;人决策(确认采购)永远要人 —— DP-4。
// ============================================================

/** 服务端专用、不可跨进程伪造的系统执行者令牌。 */
export const SYSTEM_ACTOR: unique symbol = Symbol('procurement.system-actor');

export type SystemActor = typeof SYSTEM_ACTOR;

/** 判定调用方是否是同进程的系统编排(而非客户端伪造的参数)。 */
export function isSystemActor(value: unknown): value is SystemActor {
  return value === SYSTEM_ACTOR;
}
