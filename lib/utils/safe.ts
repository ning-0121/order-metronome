/**
 * 「次要操作不阻塞主链路」的统一吞错 helper
 *
 * 用法 — 替代裸 `try { fn() } catch {}` 模式：
 *
 *   await swallow('order.notify_admin', () => notifyAdmin(...));
 *
 * 行为：
 *   - 主链路（createOrder / markMilestoneDone 等）不被通知失败、推送失败、
 *     缓存清理失败这些次要操作拖垮
 *   - 但错误会进 console.warn，运维 / 排查时能看到完整堆栈
 *   - 之前一堆 `} catch {} // xxx 失败不阻断` 写法等于把错误彻底吞了，
 *     线上一旦通知/推送链路坏了完全没人知道，悄无声息地掉数据
 *
 * 不要用于：
 *   - 关键链路操作（订单创建本身、状态机转换、权限校验）— 失败必须返回 error
 *   - 用户可见的反馈链路 — 失败应该 showError，不是吞掉
 */
export async function swallow<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  try {
    return await fn();
  } catch (e: any) {
    console.warn(`[swallow:${label}] failed:`, e?.message || String(e));
    return null;
  }
}
