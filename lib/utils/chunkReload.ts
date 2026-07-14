/**
 * 「丢页面」自愈公共逻辑 —— 部署后旧 chunk/RSC 失效导致的加载错误,
 * 统一判定 + 自动整页重载一次(带会话内防循环护栏)。
 * 供 ChunkErrorReloader(window 监听)与各 error.tsx 边界共用,单一真源。
 */
const RELOAD_GUARD_KEY = 'qm_chunk_reload_at';
const RELOAD_COOLDOWN_MS = 15_000;

export function isChunkLoadError(reason: unknown): boolean {
  if (!reason) return false;
  const name = (reason as any)?.name || '';
  const msg = String((reason as any)?.message ?? reason ?? '');
  if (name === 'ChunkLoadError') return true;
  return (
    /Loading chunk [\d]+ failed/i.test(msg) ||
    /Loading CSS chunk/i.test(msg) ||
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /error loading dynamically imported module/i.test(msg) ||
    /Importing a module script failed/i.test(msg) ||
    /module script failed/i.test(msg) ||
    /'text\/html' is not a valid JavaScript MIME type/i.test(msg)
  );
}

/** 整页硬重载自愈;最近刚重载过则不再重载(交给错误边界显示,避免死循环)。 */
export function selfHealReload(): void {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) || '0');
    const now = Date.now();
    if (now - last < RELOAD_COOLDOWN_MS) return;
    sessionStorage.setItem(RELOAD_GUARD_KEY, String(now));
  } catch {
    // sessionStorage 不可用 → 仍尝试重载
  }
  window.location.reload();
}

/** 若给定错误是 chunk 加载类错误,则触发自愈重载,返回是否已触发。 */
export function maybeSelfHealChunkError(reason: unknown): boolean {
  if (!isChunkLoadError(reason)) return false;
  selfHealReload();
  return true;
}
