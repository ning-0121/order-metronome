'use client';

/**
 * 「保存草稿」按钮 —— 放在建单页最底部,和「创建订单」并排(2026-08-04 CEO)。
 *
 * CEO 原话:「保存草稿按钮不要放在中间,放在页面最下面,要么提交,要么保存草稿。」
 * 之前它在表单中段的一条横条里(OrderDraftBar),既打断填写节奏,又让人以为是个必填环节。
 * 现在收敛成底部两个出口:**提交 / 存草稿**,语义干净。
 *
 * 「继续填写」不在这里 —— 那是**进来之前**的动作,入口在订单中心的「我的未完成草稿」,
 * 点进来会带 ?draft=xxx 自动回填(见 OrderDraftBar 的 autoRestoreDraftId)。
 * 此前草稿只能在建单页内部找,离开页面就回不去,这正是 order_drafts 上线至今 0 行的原因。
 *
 * 附件不进草稿:序列化阶段已排除 file/password/secret/token(浏览器也不允许回填文件框),
 * 所以每次保存都提示附件要重新选 —— 与崩溃恢复那条提示同口径。
 */

import { useState } from 'react';
import { saveOrderDraft } from '@/app/actions/order-drafts';
import { serializeSafeOrderDraft } from '@/lib/order/create-order-resilience';

interface Props {
  formRef: React.RefObject<HTMLFormElement | null>;
  draftId: string | null;
  onDraftIdChange: (id: string | null) => void;
}

/** 草稿名:客户 + 款号/PO,给订单中心列表里认人用 */
function labelFrom(fields: Array<[string, string]>): string {
  const get = (k: string) => fields.find(([n]) => n === k)?.[1]?.trim() || '';
  const parts = [get('customer_name'), get('style_no') || get('po_number')].filter(Boolean);
  return parts.join(' · ') || '未命名草稿';
}

export function OrderDraftSaveButton({ formRef, draftId, onDraftIdChange }: Props) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  async function handleSave() {
    const form = formRef.current;
    if (!form) return;
    const snap = serializeSafeOrderDraft(form);
    const nonEmpty = snap.fields.filter(([, v]) => String(v || '').trim() !== '');
    if (nonEmpty.length === 0) {
      setMsg({ kind: 'err', text: '还没填任何内容,不用存草稿。' });
      return;
    }
    setBusy(true);
    setMsg(null);
    // 只存非空字段 —— 与 OrderDraftBar 同口径,免得草稿里塞一堆空串
    const res = await saveOrderDraft({ draftId, label: labelFrom(nonEmpty), fields: nonEmpty });
    setBusy(false);
    if (res.error) {
      setMsg({ kind: 'err', text: res.error });
      return;
    }
    onDraftIdChange(res.draftId || null);
    setMsg({
      kind: 'ok',
      text: `已存草稿(${nonEmpty.length} 项)。到「订单中心 → 我的未完成草稿」可接着填;换台电脑登录也在。附件需重新选。`,
    });
  }

  return (
    <>
      {msg && (
        <p className={`w-full text-xs mb-2 text-right ${msg.kind === 'ok' ? 'text-emerald-700' : 'text-rose-600'}`}>
          {msg.text}
        </p>
      )}
      <button
        type="button"
        onClick={handleSave}
        disabled={busy}
        title="填一半有事要走?存下来,回头从订单中心接着填"
        className="rounded-lg border border-indigo-300 px-4 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
      >
        {busy ? '保存中…' : draftId ? '💾 更新草稿' : '💾 保存草稿'}
      </button>
    </>
  );
}
