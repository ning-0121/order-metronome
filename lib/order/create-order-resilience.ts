export const STALE_SERVER_ACTION_MESSAGE =
  '系统刚完成更新，当前页面版本已过期。请刷新页面后继续，已填写内容将尽量保留。';

export const CREATE_ORDER_DRAFT_KEY = 'qimo:create-order:safe-draft:v1';

const EXCLUDED_PERSISTED_FIELDS = /(?:file|password|secret|token|po_parse_snapshot)/i;

/**
 * 认出「页面 JS 过期,不是业务出错」这一类失败。
 *
 * Next.js 每次部署都会给 Server Action 换 ID,用户**已经打开**的页面还拿着旧引用,
 * 一调就废。但它并不只用一种报文,这里三句都要认:
 *   · `Failed to find Server Action …`         —— action ID 找不到
 *   · `Server Action … was not found on the server`
 *   · `An unexpected response was received from the server.`
 *     ↑ 2026-08-05 漏网的就是这句。响应不是合法 RSC 载荷时抛(旧页面 POST 打到新部署,
 *       拿回 HTML 错误页/重定向)。因为没被认出来,用户看到的是这句英文天书,
 *       而不是「请刷新页面」—— 于是反复点重试(没用,重试还是旧 JS)。
 *
 * ⚠️ 最后这句并非 100% 等于部署换版:函数超时(504)拿回 HTML 也是同样报文。
 *    所以提示语只说「请刷新页面后继续」,不打包票说是更新导致 ——
 *    刷新一次就能自证:还错就是真 bug,要去查 vercel logs。
 */
export function isStaleServerActionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return /Failed to find Server Action|Server Action .* was not found on the server|An unexpected response was received from the server/i.test(message);
}

export type SafeOrderDraft = { savedAt: string; fields: Array<[string, string]> };

export function serializeSafeOrderDraft(formData: FormData): SafeOrderDraft {
  const fields: Array<[string, string]> = [];
  for (const [name, value] of formData.entries()) {
    if (typeof value !== 'string' || EXCLUDED_PERSISTED_FIELDS.test(name)) continue;
    fields.push([name, value]);
  }
  return { savedAt: new Date().toISOString(), fields };
}

export function saveSafeOrderDraft(formData: FormData, storage: Pick<Storage, 'setItem'> = sessionStorage) {
  storage.setItem(CREATE_ORDER_DRAFT_KEY, JSON.stringify(serializeSafeOrderDraft(formData)));
}

export function loadSafeOrderDraft(storage: Pick<Storage, 'getItem'> = sessionStorage): SafeOrderDraft | null {
  const raw = storage.getItem(CREATE_ORDER_DRAFT_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SafeOrderDraft;
    return Array.isArray(parsed?.fields) ? parsed : null;
  } catch { return null; }
}

export function clearSafeOrderDraft(storage: Pick<Storage, 'removeItem'> = sessionStorage) {
  storage.removeItem(CREATE_ORDER_DRAFT_KEY);
}

export function restoreSafeOrderDraft(form: HTMLFormElement, draft: SafeOrderDraft) {
  for (const [name, value] of draft.fields) {
    // CustomerSelect owns this pair as one canonical value. The parent restores it atomically.
    if (name === 'customer_id' || name === 'customer_name') continue;
    const field = form.elements.namedItem(name);
    if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement)) continue;
    if (field instanceof HTMLInputElement && (field.type === 'file' || field.type === 'password')) continue;
    if (field instanceof HTMLInputElement && (field.type === 'checkbox' || field.type === 'radio')) field.checked = value === field.value || value === 'true' || value === 'on';
    else field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }
}
