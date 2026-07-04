'use client';

/**
 * 轻量 · 无依赖 · promise 式对话框 hook —— 替换原生 window.confirm / window.prompt。
 *
 * 用法:
 *   const { confirm, prompt, DialogHost } = useDialogs();
 *   ...
 *   if (!(await confirm({ title: '批准补采购?', message: '批准后采购部即可执行', danger: false }))) return;
 *   const v = await prompt({
 *     title: '补采购数量',
 *     fields: [
 *       { name: 'qty', label: '补多少', type: 'number', required: true, suffix: 'kg' },
 *       { name: 'reason', label: '原因(财务审批要看)', type: 'textarea', required: true },
 *     ],
 *   });
 *   if (!v) return;            // 取消
 *   const qty = Number(v.qty); const reason = v.reason;
 *   ...
 *   return ( <>{...}<DialogHost/></> );   // 在组件里挂一次
 *
 * confirm → Promise<boolean>;prompt → Promise<Record<string,string> | null>(null=取消)。
 * 字段 required 未填会内联报错,不 resolve。Esc/点遮罩/取消 = 取消。
 */

import { useCallback, useRef, useState, type ReactNode } from 'react';

export interface DialogField {
  name: string;
  label: string;
  type?: 'text' | 'number' | 'textarea';
  required?: boolean;
  placeholder?: string;
  suffix?: string;          // 单位等后缀
  defaultValue?: string;
}

interface ConfirmOpts {
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}
interface PromptOpts extends ConfirmOpts {
  fields: DialogField[];
}

type Active =
  | { kind: 'confirm'; opts: ConfirmOpts; resolve: (v: boolean) => void }
  | { kind: 'prompt'; opts: PromptOpts; resolve: (v: Record<string, string> | null) => void };

export function useDialogs() {
  const [active, setActive] = useState<Active | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const resolverRef = useRef<Active['resolve'] | null>(null);

  const close = useCallback((result: boolean | Record<string, string> | null) => {
    const r = resolverRef.current;
    resolverRef.current = null;
    setActive(null); setValues({}); setErrors({}); setBusy(false);
    if (r) (r as (v: unknown) => void)(result);
  }, []);

  const confirm = useCallback((opts: ConfirmOpts) => {
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve as Active['resolve'];
      setActive({ kind: 'confirm', opts, resolve: resolve as (v: boolean) => void });
    });
  }, []);

  const prompt = useCallback((opts: PromptOpts) => {
    return new Promise<Record<string, string> | null>((resolve) => {
      resolverRef.current = resolve as Active['resolve'];
      const init: Record<string, string> = {};
      for (const f of opts.fields) init[f.name] = f.defaultValue ?? '';
      setValues(init); setErrors({});
      setActive({ kind: 'prompt', opts, resolve: resolve as (v: Record<string, string> | null) => void });
    });
  }, []);

  function submitPrompt() {
    if (!active || active.kind !== 'prompt') return;
    const errs: Record<string, string> = {};
    for (const f of active.opts.fields) {
      const raw = (values[f.name] ?? '').trim();
      if (f.required && !raw) errs[f.name] = '必填';
      else if (f.type === 'number' && raw && (isNaN(Number(raw)) || Number(raw) <= 0)) errs[f.name] = '请输入大于 0 的数字';
    }
    if (Object.keys(errs).length) { setErrors(errs); return; }
    const out: Record<string, string> = {};
    for (const f of active.opts.fields) out[f.name] = (values[f.name] ?? '').trim();
    close(out);
  }

  // 返回 JSX 节点(而非组件):按位置协调,state 变化不重挂 → 输入不丢焦、autoFocus 只在打开时触发一次。
  let dialog: ReactNode = null;
  if (active) {
    const o = active.opts;
    const confirmTone = o.danger
      ? 'bg-rose-600 hover:bg-rose-700'
      : 'bg-indigo-600 hover:bg-indigo-700';
    dialog = (
      <div
        className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4"
        onClick={() => close(active.kind === 'prompt' ? null : false)}
        onKeyDown={(e) => { if (e.key === 'Escape') close(active.kind === 'prompt' ? null : false); }}
      >
        <div className="bg-white rounded-xl max-w-md w-full shadow-2xl" onClick={(e) => e.stopPropagation()}>
          <div className="px-5 pt-5">
            <h3 className="text-sm font-semibold text-gray-900">{o.title}</h3>
            {o.message && <p className="mt-1.5 text-xs text-gray-500 whitespace-pre-line">{o.message}</p>}
          </div>

          {active.kind === 'prompt' && (
            <div className="px-5 pt-3 space-y-3">
              {active.opts.fields.map((f) => (
                <div key={f.name}>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    {f.label}{f.required && <span className="text-rose-500"> *</span>}
                  </label>
                  <div className="flex items-center gap-2">
                    {f.type === 'textarea' ? (
                      <textarea
                        autoFocus={active.opts.fields[0].name === f.name}
                        rows={2} value={values[f.name] ?? ''} placeholder={f.placeholder}
                        onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:border-indigo-400"
                      />
                    ) : (
                      <input
                        autoFocus={active.opts.fields[0].name === f.name}
                        type={f.type === 'number' ? 'number' : 'text'} inputMode={f.type === 'number' ? 'decimal' : undefined}
                        value={values[f.name] ?? ''} placeholder={f.placeholder}
                        onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === 'Enter' && f.type !== 'textarea') submitPrompt(); }}
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:border-indigo-400"
                      />
                    )}
                    {f.suffix && <span className="text-xs text-gray-400 shrink-0">{f.suffix}</span>}
                  </div>
                  {errors[f.name] && <p className="mt-1 text-xs text-rose-500">{errors[f.name]}</p>}
                </div>
              ))}
            </div>
          )}

          <div className="flex justify-end gap-2 px-5 py-4 mt-1">
            <button
              onClick={() => close(active.kind === 'prompt' ? null : false)}
              className="px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50"
            >
              {o.cancelText || '取消'}
            </button>
            <button
              disabled={busy}
              onClick={() => { if (active.kind === 'prompt') submitPrompt(); else close(true); }}
              className={`px-4 py-2 rounded-lg text-sm text-white font-medium disabled:opacity-50 ${confirmTone}`}
            >
              {o.confirmText || '确认'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return { confirm, prompt, dialog, setDialogBusy: setBusy };
}
