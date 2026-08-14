// ============================================================
// Procurement Generator P0+P1 —— Pilot 门禁(2026-08-13)
//
// CEO 拍板:只对 3–5 张新 EHL 订单 + 1 名跟单 + 1 名采购启用。
// **非 Pilot 订单行为必须保持完全不变** —— 这是本轮唯一的安全边界:
// 采购是钱的入口,新链路走错等于对着供应商下错单。
//
// 双闸(两个都得过,任一不满足即视为不在 Pilot):
//   ① PROCUREMENT_GENERATOR_PILOT   = 订单号白名单(逗号分隔),或 'off'(默认)
//   ② PROCUREMENT_GENERATOR_MAX     = 名单再大也不超过这个数(默认 5),防手滑贴进整列表
//
// 回滚:env 改回 off,新链路即刻全灭,老路径一行没动。
// ============================================================

const DEFAULT_MAX = 5;

/** 解析白名单。空/off/false/0 一律视为关闭。 */
export function pilotOrderNos(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = String(env.PROCUREMENT_GENERATOR_PILOT ?? '').trim();
  if (!raw || /^(off|false|0|no)$/i.test(raw)) return [];
  const max = Number(env.PROCUREMENT_GENERATOR_MAX) > 0
    ? Number(env.PROCUREMENT_GENERATOR_MAX) : DEFAULT_MAX;
  const list = raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  // 超上限时**取前 N 张而不是全放行**:宁可少跑,不可失控
  return Array.from(new Set(list)).slice(0, max);
}

/**
 * 该订单是否在 Pilot 内。
 * 用 order_no（人认得、员工报障时报得出来），不用 uuid。
 * internal_order_no 也认 —— 员工习惯用订单册编号。
 */
export function isPilotOrder(
  order: { order_no?: string | null; internal_order_no?: string | null } | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const list = pilotOrderNos(env);
  if (list.length === 0) return false;
  const keys = [order?.order_no, order?.internal_order_no]
    .map((s) => String(s ?? '').trim().toUpperCase()).filter(Boolean);
  if (keys.length === 0) return false;
  const set = new Set(list.map((s) => s.toUpperCase()));
  return keys.some((k) => set.has(k));
}

/** Pilot 是否整体开启（用于 UI 决定要不要显示新入口，避免全员看到半成品）。 */
export function isPilotEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return pilotOrderNos(env).length > 0;
}
