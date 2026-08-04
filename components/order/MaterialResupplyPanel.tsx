'use client';

/**
 * 补料申请面板(CEO 2026-08-04 定口径)。
 *
 * 链路:**生产部提请(带责任方 + 签字的责任认定书)→ 采购审核 → 财务审核 → 方能补料**
 *
 * 一个面板承载三种角色的动作,而不是拆成三个页面 —— 补料的上下文(补什么、为什么、谁的责任、
 * 凭证)三方看的是同一份,分页只会让审的人少看一样东西。按当前状态 + 当前角色决定露哪个按钮。
 *
 * 【为什么责任方要选得这么显眼】
 * 它决定财务建不建供应商扣款:factory/supplier → 建;customer/qimo → 不建。
 * 2026-08-02 事故里「要扣加工厂的费用忘了登记」,根子就是责任认定没在当下落下来。
 * 所以这里不给默认值、不许留空 —— 逼提请人当场想清楚。
 *
 * 上传沿用采购单凭证那套(order-docs bucket + 浏览器压图防网关 413),不另造一套。
 */

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { createClient as createBrowserClient } from '@/lib/supabase/client';
import { compressImageForUpload, friendlyUploadError } from '@/lib/utils/image-compress';
import { useDialogs } from '@/components/ui/useDialogs';
import {
  listResupplyRequests, submitResupplyRequest,
  procurementReviewResupply, financeReviewResupply,
  type ResupplyRow,
} from '@/app/actions/material-resupply';

const LIABLE: Array<{ v: ResupplyRow['liable_party']; label: string; hint: string }> = [
  { v: 'factory', label: '工厂责任', hint: '工厂做坏/做少/损耗超标 → 财务会建待扣款' },
  { v: 'supplier', label: '供应商责任', hint: '来料不良/短少 → 财务会建待扣款' },
  { v: 'customer', label: '客户责任', hint: '客户改单/加量 → 不扣款,费用另计' },
  { v: 'qimo', label: '我方责任', hint: '我们算错/漏订 → 不扣款' },
  { v: 'unknown', label: '待认定', hint: '暂时判不了 → 不扣款,但必须后续补认定' },
];

const STATUS: Record<ResupplyRow['status'], { label: string; cls: string }> = {
  pending_procurement: { label: '待采购审核', cls: 'bg-amber-100 text-amber-800' },
  pending_finance: { label: '待财务审核', cls: 'bg-indigo-100 text-indigo-800' },
  approved: { label: '✅ 已通过,可补料', cls: 'bg-emerald-100 text-emerald-800' },
  rejected: { label: '⛔ 已驳回', cls: 'bg-rose-100 text-rose-700' },
  cancelled: { label: '已取消', cls: 'bg-gray-100 text-gray-500' },
};

export function MaterialResupplyPanel({
  orderId, canRequest, canReviewProcurement, canReviewFinance,
}: {
  orderId: string;
  canRequest: boolean;
  canReviewProcurement: boolean;
  canReviewFinance: boolean;
}) {
  const { confirm, dialog } = useDialogs();
  const router = useRouter();
  const [rows, setRows] = useState<ResupplyRow[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [uploading, setUploading] = useState(false);

  // 表单
  const [name, setName] = useState('');
  const [spec, setSpec] = useState('');
  const [qty, setQty] = useState('');
  const [unit, setUnit] = useState('');
  const [reason, setReason] = useState('');
  const [liable, setLiable] = useState<ResupplyRow['liable_party'] | ''>('');
  const [liableNote, setLiableNote] = useState('');
  const [paths, setPaths] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    const r = await listResupplyRequests(orderId);
    if (r.data) setRows(r.data);
  }, [orderId]);
  useEffect(() => { void refresh(); }, [refresh]);

  async function upload(files: FileList) {
    setUploading(true);
    try {
      const supabase = createBrowserClient();
      const added: string[] = [];
      for (const f of Array.from(files)) {
        const { blob, ext, type } = await compressImageForUpload(f);
        const path = `resupply/${orderId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const { error } = await supabase.storage.from('order-docs').upload(path, blob, { contentType: type, upsert: false });
        if (error) { await confirm({ title: '上传失败:' + friendlyUploadError(error.message, f.name), confirmText: '知道了' }); continue; }
        added.push(path);
      }
      if (added.length) setPaths((p) => [...p, ...added]);
    } catch (e: any) {
      await confirm({ title: '上传异常:' + (e?.message || String(e)), confirmText: '知道了' });
    }
    setUploading(false);
  }

  async function preview(path: string) {
    const supabase = createBrowserClient();
    const { data } = await supabase.storage.from('order-docs').createSignedUrl(path, 3600);
    if (data?.signedUrl) window.open(data.signedUrl, '_blank');
  }

  async function submit() {
    if (!liable) { await confirm({ title: '请先选责任方', message: '责任方决定财务是否向供应商扣款,必须当场认定。', confirmText: '知道了' }); return; }
    if (paths.length === 0) { await confirm({ title: '缺少责任认定书', message: '必须上传**签字的**责任认定书才能提交 —— 责任认定只能在当下做,事后说不清。', confirmText: '知道了' }); return; }
    setBusy('submit');
    const r = await submitResupplyRequest({
      orderId, materialName: name, specification: spec || null,
      quantity: qty ? Number(qty) : null, unit: unit || null,
      reason, liableParty: liable, liableNote: liableNote || null, evidencePaths: paths,
    });
    setBusy('');
    if (r.error) { await confirm({ title: '提交失败', message: r.error, confirmText: '知道了' }); return; }
    setOpen(false);
    setName(''); setSpec(''); setQty(''); setUnit(''); setReason(''); setLiable(''); setLiableNote(''); setPaths([]);
    await refresh(); router.refresh();
  }

  async function review(row: ResupplyRow, stage: 'procurement' | 'finance', decision: 'approve' | 'reject') {
    let note = '';
    if (decision === 'reject') {
      const v = window.prompt('驳回原因(必填):');
      if (!v?.trim()) return;
      note = v.trim();
    } else {
      const ok = await confirm({
        title: stage === 'finance' ? '财务通过?通过后即可补料' : '采购通过?将转财务审核',
        message: `${row.material_name} · 责任方:${LIABLE.find((l) => l.v === row.liable_party)?.label}\n` +
          (stage === 'finance' && ['factory', 'supplier'].includes(row.liable_party)
            ? '\n⚠️ 责任方是工厂/供应商 —— 通过后财务系统会建一条**待扣款**,金额由你在财务系统里定。'
            : '\n责任方非工厂/供应商,财务系统不会建扣款。'),
        confirmText: '通过',
      });
      if (!ok) return;
    }
    setBusy(row.id);
    const r = stage === 'procurement'
      ? await procurementReviewResupply(row.id, decision, note)
      : await financeReviewResupply(row.id, decision, note);
    setBusy('');
    if (r.error) { await confirm({ title: '操作失败', message: r.error, confirmText: '知道了' }); return; }
    await refresh(); router.refresh();
  }

  const inp = 'w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5';

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      {dialog}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
        <h2 className="text-lg font-semibold text-gray-900">🧵 补料申请</h2>
        {canRequest && !open && (
          <button onClick={() => setOpen(true)}
            className="text-xs font-medium px-3 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700">
            + 提请补料
          </button>
        )}
      </div>
      <p className="text-xs text-gray-500 mb-4">
        生产部提请 → 采购审核 → 财务审核 → 方能补料。
        <b>责任方决定财务是否向供应商扣款</b>,必须当场认定并上传签字的责任认定书。
      </p>

      {open && (
        <div className="mb-4 rounded-xl border-2 border-indigo-200 bg-indigo-50/40 p-3 space-y-2">
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
            <label className="text-xs text-gray-700 sm:col-span-2">
              <span className="block mb-1">补什么料 <span className="text-rose-600">*</span></span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如:主标 / 松紧带" className={inp} />
            </label>
            <label className="text-xs text-gray-700">
              <span className="block mb-1">规格</span>
              <input value={spec} onChange={(e) => setSpec(e.target.value)} className={inp} />
            </label>
            <label className="text-xs text-gray-700">
              <span className="block mb-1">数量 / 单位</span>
              <div className="flex gap-1">
                <input value={qty} onChange={(e) => setQty(e.target.value)} type="number" className={inp} />
                <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="个" className={`${inp} w-16`} />
              </div>
            </label>
          </div>

          <label className="block text-xs text-gray-700">
            <span className="block mb-1">补料原因 <span className="text-rose-600">*</span></span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="如:裁床裁坏 200 件用量" className={inp} />
          </label>

          <div className="text-xs text-gray-700">
            <span className="block mb-1">谁的责任 <span className="text-rose-600">*</span>
              <span className="text-gray-400 ml-1">—— 选错会冤枉供应商,请当场认定</span>
            </span>
            <div className="flex flex-wrap gap-1.5">
              {LIABLE.map((l) => (
                <button key={l.v} type="button" title={l.hint} onClick={() => setLiable(l.v)}
                  className={`px-2.5 py-1 rounded-lg text-xs border ${liable === l.v
                    ? 'bg-indigo-600 text-white border-indigo-600'
                    : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'}`}>
                  {l.label}
                </button>
              ))}
            </div>
            {liable && <p className="mt-1 text-[11px] text-indigo-700">{LIABLE.find((l) => l.v === liable)?.hint}</p>}
          </div>

          <label className="block text-xs text-gray-700">
            <span className="block mb-1">责任认定说明</span>
            <input value={liableNote} onChange={(e) => setLiableNote(e.target.value)} placeholder="怎么认定的、谁签的字" className={inp} />
          </label>

          <div className="text-xs text-gray-700">
            <span className="block mb-1">签字的责任认定书 <span className="text-rose-600">*</span>
              <span className="text-gray-400 ml-1">—— 没有它提交不了</span>
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <label className={`px-3 py-1.5 rounded-lg border border-indigo-300 text-indigo-700 text-xs cursor-pointer hover:bg-indigo-50 ${uploading ? 'opacity-50 pointer-events-none' : ''}`}>
                {uploading ? '上传中…' : '📎 上传认定书'}
                <input type="file" multiple accept="image/*,.pdf" className="hidden"
                  onChange={(e) => e.target.files && upload(e.target.files)} />
              </label>
              {paths.map((p) => (
                <span key={p} className="inline-flex items-center gap-1 text-[11px] bg-white border border-gray-200 rounded px-2 py-1">
                  <button onClick={() => preview(p)} className="text-indigo-600 hover:underline">凭证</button>
                  <button onClick={() => setPaths((x) => x.filter((y) => y !== p))} className="text-gray-400 hover:text-rose-600">×</button>
                </span>
              ))}
            </div>
          </div>

          <div className="flex gap-2 pt-1">
            <button onClick={submit} disabled={busy === 'submit'}
              className="text-xs font-medium px-4 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
              {busy === 'submit' ? '提交中…' : '提交申请'}
            </button>
            <button onClick={() => setOpen(false)} className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700">取消</button>
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-gray-400">暂无补料申请。</p>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => {
            const st = STATUS[r.status];
            const mine = LIABLE.find((l) => l.v === r.liable_party);
            const showProc = canReviewProcurement && r.status === 'pending_procurement';
            const showFin = canReviewFinance && r.status === 'pending_finance';
            return (
              <div key={r.id} className="rounded-lg border border-gray-200 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-gray-900">{r.material_name}</span>
                  {r.specification && <span className="text-xs text-gray-500">{r.specification}</span>}
                  {r.quantity != null && <span className="text-xs text-gray-500">{r.quantity}{r.unit || ''}</span>}
                  <span className={`text-xs px-2 py-0.5 rounded-full ${st.cls}`}>{st.label}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${['factory', 'supplier'].includes(r.liable_party) ? 'bg-orange-100 text-orange-800' : 'bg-gray-100 text-gray-600'}`}>
                    {mine?.label}
                  </span>
                  <span className="grow" />
                  <span className="text-[11px] text-gray-400">{r.requested_by_name} · {String(r.requested_at).slice(0, 10)}</span>
                </div>
                <p className="text-xs text-gray-600 mt-1">原因:{r.reason}{r.liable_note ? ` · 认定:${r.liable_note}` : ''}</p>
                <div className="flex flex-wrap items-center gap-2 mt-1.5">
                  {(r.evidence_paths || []).map((p, i) => (
                    <button key={p} onClick={() => preview(p)} className="text-[11px] text-indigo-600 hover:underline">认定书{i + 1}</button>
                  ))}
                  {r.procurement_reviewed_by_name && <span className="text-[11px] text-gray-500">采购:{r.procurement_reviewed_by_name}{r.procurement_note ? `(${r.procurement_note})` : ''}</span>}
                  {r.finance_reviewed_by_name && <span className="text-[11px] text-gray-500">财务:{r.finance_reviewed_by_name}{r.finance_note ? `(${r.finance_note})` : ''}</span>}
                  {r.reject_reason && <span className="text-[11px] text-rose-600">驳回:{r.reject_reason}</span>}
                  <span className="grow" />
                  {(showProc || showFin) && (
                    <>
                      <button onClick={() => review(r, showProc ? 'procurement' : 'finance', 'approve')} disabled={busy === r.id}
                        className="text-xs px-3 py-1 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
                        {busy === r.id ? '处理中…' : showProc ? '采购通过' : '财务通过'}
                      </button>
                      <button onClick={() => review(r, showProc ? 'procurement' : 'finance', 'reject')} disabled={busy === r.id}
                        className="text-xs px-3 py-1 rounded-lg border border-rose-300 text-rose-700 hover:bg-rose-50 disabled:opacity-50">
                        驳回
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
