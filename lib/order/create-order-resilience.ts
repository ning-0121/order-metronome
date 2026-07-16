export const STALE_SERVER_ACTION_MESSAGE =
  '系统刚完成更新，当前页面版本已过期。请刷新页面后继续，已填写内容将尽量保留。';

export const CREATE_ORDER_DRAFT_KEY = 'qimo:create-order:safe-draft:v1';

const EXCLUDED_PERSISTED_FIELDS = /(?:file|password|secret|token|po_parse_snapshot)/i;

export function isStaleServerActionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return /Failed to find Server Action|Server Action .* was not found on the server/i.test(message);
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
    const field = form.elements.namedItem(name);
    if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement)) continue;
    if (field instanceof HTMLInputElement && (field.type === 'file' || field.type === 'password')) continue;
    if (field instanceof HTMLInputElement && (field.type === 'checkbox' || field.type === 'radio')) field.checked = value === field.value || value === 'true' || value === 'on';
    else field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }
}
