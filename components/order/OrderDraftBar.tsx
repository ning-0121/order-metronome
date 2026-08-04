'use client';

/**
 * 创建订单「保存草稿」条(2026-07-30 用户提:填一半有事离开,回来接着填)。
 *
 * 与既有的 sessionStorage 崩溃恢复分工:
 *   · create-order-resilience.ts —— 自动的换版/崩溃兜底,同标签页内,用户无感
 *   · 本组件 + order_drafts 表   —— 用户【显式保存】,跨设备、可列出、可删
 * 字段快照复用 serializeSafeOrderDraft / restoreSafeOrderDraft,不另写一套序列化。
 *
 * 附件不进草稿:序列化阶段已排除 file/password/secret/token(浏览器也不允许回填文件框),
 * 所以恢复后必须提示重新选文件 —— 与崩溃恢复那条提示同口径。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  serializeSafeOrderDraft, restoreSafeOrderDraft, type SafeOrderDraft,
} from '@/lib/order/create-order-resilience';
import {
  saveOrderDraft, listMyOrderDrafts, getOrderDraft, deleteOrderDraft, type OrderDraftRow,
} from '@/app/actions/order-drafts';

interface Props {
  formRef: React.RefObject<HTMLFormElement | null>;
  /** 当前正在编辑的草稿 id(存过一次后回填,后续保存就是更新同一条) */
  draftId: string | null;
  onDraftIdChange: (id: string | null) => void;
  /** 回填后通知父组件同步受控字段(客户选择等 DOM 之外的 state) */
  onRestored: (fields: Array<[string, string]>) => void;
  /** 从订单中心「继续填写」带过来的草稿 id(?draft=xxx)—— 进页面自动回填一次。
   *  2026-08-04 CEO:「订单中心里应该有每个人做一半的草稿,被打断了可以点进去接着做」。
   *  此前草稿只能在建单页内部的下拉里找,离开页面就再也回不去 —— 这是 order_drafts
   *  上线至今 0 行的直接原因:能存,但没有回到它的路。 */
  autoRestoreDraftId?: string | null;
  /** 只做「带 ?draft= 自动回填」,不渲染任何界面。
   *  保存按钮已移到页面底部(OrderDraftSaveButton),这里不再占版面。 */
  hideUI?: boolean;
}

function fmt(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 草稿名:客户 + 款号,给列表里认人用 */
function labelFrom(fields: Array<[string, string]>): string {
  const get = (k: string) => fields.find(([n]) => n === k)?.[1]?.trim() || '';
  const parts = [get('customer_name'), get('style_no') || get('po_number')].filter(Boolean);
  return parts.join(' · ') || '未命名草稿';
}

export function OrderDraftBar({ formRef, draftId, onDraftIdChange, onRestored, autoRestoreDraftId, hideUI }: Props) {
  const [drafts, setDrafts] = useState<OrderDraftRow[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string>('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const refresh = useCallback(async () => {
    const res = await listMyOrderDrafts();
    if (res.data) setDrafts(res.data);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // 带 ?draft= 进来 → 自动回填一次(只做一次,回填后 draftId 已被设上,不会重复触发)
  const autoDone = useRef(false);
  useEffect(() => {
    if (!autoRestoreDraftId || autoDone.current) return;
    autoDone.current = true;
    void handleRestore(autoRestoreDraftId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRestoreDraftId]);

  async function handleSave() {
    const form = formRef.current;
    if (!form) return;
    setMsg(null);
    setBusy('save');
    const snapshot: SafeOrderDraft = serializeSafeOrderDraft(new FormData(form));
    const nonEmpty = snapshot.fields.filter(([, v]) => v && v.trim() !== '');
    if (nonEmpty.length === 0) {
      setBusy(''); setMsg({ kind: 'err', text: '表单还是空的,没什么可存的。' }); return;
    }
    const res = await saveOrderDraft({ draftId, label: labelFrom(nonEmpty), fields: nonEmpty });
    setBusy('');
    if (res.error) { setMsg({ kind: 'err', text: res.error }); return; }
    onDraftIdChange(res.draftId || null);
    setMsg({ kind: 'ok', text: `已保存草稿(${nonEmpty.length} 项)。换台电脑登录也能接着填;附件需要重新选。` });
    void refresh();
  }

  async function handleRestore(id: string) {
    const form = formRef.current;
    if (!form) return;
    setMsg(null);
    setBusy('restore:' + id);
    const res = await getOrderDraft(id);
    setBusy('');
    if (res.error || !res.data) { setMsg({ kind: 'err', text: res.error || '草稿读取失败' }); return; }
    // 先同步父组件的受控 state,再回填 DOM —— 顺序与崩溃恢复一致
    onRestored(res.data.fields);
    restoreSafeOrderDraft(form, { savedAt: res.data.updatedAt, fields: res.data.fields });
    onDraftIdChange(res.data.id);
    setOpen(false);
    setMsg({ kind: 'ok', text: '已填回草稿内容。⚠️ 客户 PO / 内部报价等附件浏览器不允许自动回填,请重新选择。' });
  }

  async function handleDelete(id: string) {
    if (!window.confirm('删除这份草稿?删了不可恢复。')) return;
    setBusy('del:' + id);
    const res = await deleteOrderDraft(id);
    setBusy('');
    if (res.error) { setMsg({ kind: 'err', text: res.error }); return; }
    if (draftId === id) onDraftIdChange(null);
    void refresh();
  }

  // 只当回填器用:副作用(上面的 useEffect)照跑,界面不渲染
  if (hideUI) return null;

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-xs text-gray-600">
          <span className="font-medium text-gray-800">📝 草稿</span>
          <span className="ml-2 text-gray-500">
            填一半有事可以先存,回来(或换台电脑)接着填。
            {draftId && <span className="ml-1 text-emerald-600 font-medium">· 正在编辑已存草稿</span>}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {drafts.length > 0 && (
            <button type="button" onClick={() => setOpen((v) => !v)} disabled={busy !== ''}
              className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-white disabled:opacity-50">
              {open ? '收起' : `我的草稿 (${drafts.length})`}
            </button>
          )}
          <button type="button" onClick={handleSave} disabled={busy !== ''}
            className="text-xs px-3 py-1.5 rounded-lg bg-slate-700 text-white hover:bg-slate-800 font-medium disabled:opacity-50">
            {busy === 'save' ? '保存中…' : draftId ? '更新草稿' : '保存草稿'}
          </button>
        </div>
      </div>

      {msg && (
        <p className={`text-[11px] leading-relaxed ${msg.kind === 'ok' ? 'text-emerald-700' : 'text-rose-600'}`}>
          {msg.text}
        </p>
      )}

      {open && drafts.length > 0 && (
        <ul className="divide-y divide-gray-200 border border-gray-200 rounded-lg bg-white">
          {drafts.map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-2 px-3 py-2">
              <div className="min-w-0">
                <p className="text-xs font-medium text-gray-800 truncate">{d.label || '未命名草稿'}</p>
                <p className="text-[10px] text-gray-500">{fmt(d.updatedAt)} 保存 · {d.fieldCount} 项{d.id === draftId ? ' · 当前' : ''}</p>
              </div>
              <div className="flex gap-1.5 shrink-0">
                <button type="button" onClick={() => handleRestore(d.id)} disabled={busy !== ''}
                  className="text-[11px] px-2 py-1 rounded border border-indigo-200 text-indigo-600 hover:bg-indigo-50 disabled:opacity-50">
                  {busy === 'restore:' + d.id ? '填回中…' : '继续填写'}
                </button>
                <button type="button" onClick={() => handleDelete(d.id)} disabled={busy !== ''}
                  className="text-[11px] px-2 py-1 rounded border border-gray-200 text-gray-500 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50">
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
