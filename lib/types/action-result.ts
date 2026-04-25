/**
 * Server Action 统一返回契约
 *
 * Sprint 0 加固：建立单一返回类型，逐步替换 917 处 ad-hoc shape
 * （`{error}` / `{success}` / `{ok, error}` / `{data, error: null}` ...）
 *
 * 设计原则：
 *   1. 区分 ok=true/false 单一标志位，前端只需判断 ok
 *   2. 所有错误必须有 error 字符串（面向用户的可读消息）
 *   3. 可选 code 用于程序判断（如 'AUTH_REQUIRED', 'NOT_FOUND', 'PERMISSION_DENIED'）
 *   4. 提供 toLegacyResult adapter — 老调用方平滑过渡
 *
 * 使用：
 *   // ✅ 推荐（新代码）：
 *   export async function myAction(...): Promise<ActionResult<MyData>> {
 *     if (notLoggedIn) return failure('请先登录', 'AUTH_REQUIRED');
 *     return success({ id, name });
 *   }
 *
 *   前端：
 *   const res = await myAction();
 *   if (!res.ok) { showError(res.error); return; }
 *   const data = res.data;  // 类型安全
 *
 *   // 兼容老调用方：
 *   export async function myActionLegacy(...) {
 *     return toLegacyResult(await myActionInternal(...));
 *   }
 */

// ═══════════════════════════════════════════════════════════════
//  核心类型
// ═══════════════════════════════════════════════════════════════

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string };

/** 常用错误码（业务可在此追加） */
export type ActionErrorCode =
  | 'AUTH_REQUIRED'
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'CONFLICT'
  | 'BUSINESS_BLOCKED'
  | 'DB_ERROR'
  | 'EXTERNAL_API_ERROR'
  | 'UNKNOWN';

// ═══════════════════════════════════════════════════════════════
//  构造 helper
// ═══════════════════════════════════════════════════════════════

export function success<T>(data: T): ActionResult<T>;
export function success(): ActionResult<void>;
export function success<T>(data?: T): ActionResult<T> {
  return { ok: true, data: data as T };
}

export function failure(error: string, code?: ActionErrorCode | string): ActionResult<never> {
  const r: any = { ok: false, error };
  if (code) r.code = code;
  return r;
}

// ═══════════════════════════════════════════════════════════════
//  类型守卫
// ═══════════════════════════════════════════════════════════════

export function isOk<T>(r: ActionResult<T>): r is { ok: true; data: T } {
  return r.ok === true;
}

export function isFail<T>(r: ActionResult<T>): r is { ok: false; error: string; code?: string } {
  return r.ok === false;
}

// ═══════════════════════════════════════════════════════════════
//  Adapter：把新契约转换为老格式（向后兼容用）
// ═══════════════════════════════════════════════════════════════

/**
 * 转成 {error, data} 形式（旧 server action 默认形态）
 * 用于：内部 action 已用 ActionResult，但需要保持对外 API 不变
 */
export function toLegacyResult<T>(
  r: ActionResult<T>,
): { error?: string; data?: T } {
  if (r.ok) return { data: r.data };
  return { error: r.error };
}

/**
 * 转成 {success, error} 形式（部分 action 使用）
 */
export function toLegacySuccessResult<T>(
  r: ActionResult<T>,
): { success?: boolean; error?: string; data?: T } {
  if (r.ok) return { success: true, data: r.data };
  return { success: false, error: r.error };
}

/**
 * 转成 {ok, error} 形式（与原契约结构一致，但去掉了 data 严格类型）
 */
export function toLegacyOkResult<T>(
  r: ActionResult<T>,
): { ok: boolean; error?: string; data?: T } {
  if (r.ok) return { ok: true, data: r.data };
  return { ok: false, error: r.error };
}

// ═══════════════════════════════════════════════════════════════
//  Adapter：把老格式转换为新契约（用于包装第三方 SDK 返回）
// ═══════════════════════════════════════════════════════════════

export function fromLegacyResult<T>(
  legacy: { error?: string | null; data?: T | null } | null | undefined,
): ActionResult<T> {
  if (!legacy) return failure('无返回值', 'UNKNOWN');
  if (legacy.error) return failure(legacy.error, 'UNKNOWN');
  if (legacy.data === null || legacy.data === undefined) return failure('无数据返回', 'NOT_FOUND');
  return success(legacy.data);
}

/**
 * 包裹一个可能抛错的异步函数，把异常转成 ActionResult
 * 用法：
 *   return tryAction(async () => {
 *     const x = await something();
 *     return success(x);
 *   }, 'fallback message');
 */
export async function tryAction<T>(
  fn: () => Promise<ActionResult<T>>,
  fallbackMessage = '操作失败',
): Promise<ActionResult<T>> {
  try {
    return await fn();
  } catch (err: any) {
    return failure(err?.message || fallbackMessage, 'UNKNOWN');
  }
}
