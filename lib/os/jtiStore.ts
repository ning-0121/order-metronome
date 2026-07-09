/**
 * QIMO OS — jti 重放守卫（Phase A+，内存最佳努力）
 *
 * ⚠️ Serverless 现实：每实例独立内存，非跨实例强一致。真强一致需共享存储
 * （Redis/DB），本阶段禁 DB，故这是 **最佳努力** 重放防护。token 本身无状态、
 * 可独立验签；jti 存储是叠加的 defense-in-depth。目标系统 accept 端点使用。
 *
 * TTL 天然由 token exp 界定：jti 过期即可清除（不可能再被接受）。
 */

const store = new Map<string, number>(); // jti -> exp(Unix 秒)

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function evict(cutoff: number): void {
  for (const [jti, exp] of store) {
    if (exp <= cutoff) store.delete(jti);
  }
}

/** jti 是否已被消费过（未过期的重复即重放）。 */
export function isJtiSeen(jti: string, now: number = nowSec()): boolean {
  evict(now);
  return store.has(jti);
}

/** 记录 jti 已消费，保留到其 exp。 */
export function rememberJti(jti: string, expSec: number, now: number = nowSec()): void {
  evict(now);
  store.set(jti, expSec);
}

/** 仅测试用：清空。 */
export function _resetJtiStore(): void {
  store.clear();
}
