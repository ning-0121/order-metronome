'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { exportPurchaseOrder, placePurchaseOrder, approvePurchaseOrder, savePurchaseOrderProof, setPurchaseOrderPriceTbd, resyncPurchaseOrderToFinance, changePurchaseOrderSupplier, deletePurchaseOrderLine } from '@/app/actions/purchase-orders';
import { listSuppliers } from '@/app/actions/suppliers';
import { submitPurchaseDeposit } from '@/app/actions/procurement-payment';
import { useDialogs } from '@/components/ui/useDialogs';
import { PoRemindersPanel } from '@/components/procurement/PoRemindersPanel';
import { createClient as createBrowserClient } from '@/lib/supabase/client';
import { compressImageForUpload, friendlyUploadError } from '@/lib/utils/image-compress';

const REASON_LABELS: Record<string, string> = {
  large_amount: '大额(≥5万)', price_variance: '价格偏差>5%', new_supplier: '新供应商',
  over_budget: '超预算', over_budget_total: '整单超预算', over_budget_material: '单料超预算(疑重复下单)',
  non_standard_terms: '非标账期(<60天)',
};

export function PurchaseOrderDetailClient({ view }: { view: any }) {
  const router = useRouter();
  const { confirm, prompt, dialog } = useDialogs();
  const { po, lines, orderRefs, attachments, referenceImages, canSeeFloor, canProcure, canApproveProcurement, canApproveFinance, isAdmin } = view;
  const attachFiles: Array<{ name: string; url: string }> = Array.isArray(attachments) ? attachments : [];
  const refImages: string[] = Array.isArray(referenceImages) ? referenceImages : [];
  const sup = po.suppliers || {};
  const [exporting, setExporting] = useState(false);
  const [busy, setBusy] = useState('');
  const [proofPaths, setProofPaths] = useState<string[]>(Array.isArray(po.order_proof_paths) ? po.order_proof_paths : []);
  const [proofUploading, setProofUploading] = useState(false);
  const [priceTbd, setPriceTbd] = useState<boolean>(po.price_tbd === true);

  // 修改供应商(仅草稿·仅采购):按需拉全量供应商,名称/联系人子串搜索,选中即改。
  const [supPicker, setSupPicker] = useState(false);
  const [supList, setSupList] = useState<any[] | null>(null);
  const [supQuery, setSupQuery] = useState('');
  const [supLoading, setSupLoading] = useState(false);

  async function openSupPicker() {
    setSupPicker(true);
    if (supList === null && !supLoading) {
      setSupLoading(true);
      const res = await listSuppliers();
      setSupLoading(false);
      if ((res as any).error) { await confirm({ title: (res as any).error, confirmText: '知道了' }); setSupPicker(false); return; }
      setSupList((res as any).data || []);
    }
  }

  async function pickSupplier(s: any) {
    if (s.id === po.supplier_id) { setSupPicker(false); return; }
    if (!(await confirm({ title: `改供应商为「${s.name}」?`, message: '仅草稿采购单可改;采购行供应商同步更新。', confirmText: '确认修改', cancelText: '取消' }))) return;
    setBusy('supplier');
    const res = await changePurchaseOrderSupplier(po.id, s.id);
    setBusy('');
    if ((res as any).error) { await confirm({ title: (res as any).error, confirmText: '知道了' }); return; }
    setSupPicker(false);
    router.refresh();
  }

  async function handleDeleteLine(l: any) {
    if (!(await confirm({ title: `删除采购行「${l.material_name || '该行'}」?`, message: '仅草稿单可删,删除后不可恢复(可重新归料生成)。', confirmText: '删除', cancelText: '取消' }))) return;
    setBusy('line:' + l.id);
    const res = await deletePurchaseOrderLine(po.id, l.id);
    setBusy('');
    if ((res as any).error) { await confirm({ title: (res as any).error, confirmText: '知道了' }); return; }
    router.refresh();
  }

  async function handleSetPriceTbd(v: boolean) {
    setBusy('tbd');
    const res = await setPurchaseOrderPriceTbd(po.id, v);
    setBusy('');
    if ((res as any).error) { await confirm({ title: (res as any).error, confirmText: '知道了' }); return; }
    setPriceTbd(v); router.refresh();
  }

  async function handleProofUpload(files: FileList) {
    setProofUploading(true);
    try {
      const supabase = createBrowserClient();
      const added: string[] = [];
      for (const f of Array.from(files)) {
        // 大图先在浏览器压(≤2200px JPEG),防网关 413 拒收报「not valid JSON」(与码单上传同修)
        const { blob, ext, type } = await compressImageForUpload(f);
        const path = `po-proof/${po.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const { error } = await supabase.storage.from('order-docs').upload(path, blob, { contentType: type, upsert: false });
        if (error) { await confirm({ title: '上传失败:' + friendlyUploadError(error.message, f.name), confirmText: '知道了' }); continue; }
        added.push(path);
      }
      if (added.length === 0) { setProofUploading(false); return; }
      const next = [...proofPaths, ...added];
      const res = await savePurchaseOrderProof(po.id, next);
      if ((res as any).error) { await confirm({ title: (res as any).error, confirmText: '知道了' }); setProofUploading(false); return; }
      setProofPaths(next);
    } catch (e: any) {
      await confirm({ title: '上传异常:' + (e?.message || String(e)), confirmText: '知道了' });
    }
    setProofUploading(false);
  }

  async function removeProof(path: string) {
    const next = proofPaths.filter((p) => p !== path);
    const res = await savePurchaseOrderProof(po.id, next);
    if ((res as any).error) { await confirm({ title: (res as any).error, confirmText: '知道了' }); return; }
    setProofPaths(next);
  }

  async function handlePlace() {
    setBusy('place');
    const res = await placePurchaseOrder(po.id);
    setBusy('');
    if (res.error) { await confirm({ title: res.error, confirmText: '知道了' }); return; }
    if (res.pendingApproval) { await confirm({ title: '已转审批', message: '触发:' + (res.reasons || []).map((r: string) => REASON_LABELS[r] || r).join('、'), confirmText: '知道了' }); router.refresh(); return; }
    await confirm({ title: '✅ 已下单', confirmText: '知道了' }); router.refresh();
  }
  async function handleApprove() {
    const v = await prompt({ title: '审批通过', fields: [{ name: 'note', label: '审批意见（可选）', type: 'textarea' }], confirmText: '审批通过' });
    if (!v) return;
    const note = v.note;
    setBusy('approve');
    const res = await approvePurchaseOrder(po.id, note || undefined);
    setBusy('');
    if (res.error) { await confirm({ title: res.error, confirmText: '知道了' }); return; }
    await confirm({ title: '✅ 审批通过', confirmText: '知道了' }); router.refresh();
  }

  async function handleDeposit() {
    const v = await prompt({
      title: '申请定金 / 预付',
      message: '货没到就先付供应商一笔(定金/预付)。走财务同一条付款通道审批出款;货到对账时自动从净应付里冲抵。',
      fields: [
        { name: 'amount', label: '金额', type: 'number', required: true, suffix: po.currency || 'RMB' },
        { name: 'note', label: '用途/备注(可选,如「30%定金,开工前付」)', type: 'text' },
      ],
      confirmText: '提交财务',
    });
    if (!v) return;
    setBusy('deposit');
    const res = await submitPurchaseDeposit(po.id, v.amount, { note: v.note || undefined });
    setBusy('');
    if ((res as any).error) { await confirm({ title: (res as any).error, confirmText: '知道了' }); return; }
    await confirm({ title: '✅ 定金申请已提交财务', message: `单号 ${(res as any).request_no || ''}。财务审批后经周排款出款;货到对账时自动冲抵。`, confirmText: '知道了' });
    router.refresh();
  }

  async function handleResync() {
    if (!(await confirm({ title: '重发财务同步?', message: '把本采购单的完整数据(供应商/明细/内部订单号)重推给财务系统,用于订正旧事件。', confirmText: '重发', cancelText: '取消' }))) return;
    setBusy('resync');
    const res = await resyncPurchaseOrderToFinance(po.id);
    setBusy('');
    if ((res as any).error) { await confirm({ title: (res as any).error, confirmText: '知道了' }); return; }
    await confirm({ title: '✅ 已重发财务同步', message: `事件:${(res as any).sent}`, confirmText: '知道了' });
  }

  const dualNo = `${po.po_no} · 订单 ${(orderRefs || []).map((o: any) => o.internal_order_no || o.order_no).join(' / ') || '—'}`;
  const canEditLines = canProcure && po.status === 'draft';   // 草稿单采购可删错行

  async function handleExport(withPrice: boolean) {
    setExporting(true);
    const res = await exportPurchaseOrder(po.id, { withPrice });
    setExporting(false);
    if (res.error) { await confirm({ title: res.error, confirmText: '知道了' }); return; }
    if (res.base64 && res.fileName) {
      const bin = atob(res.base64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([arr], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const a = document.createElement('a'); a.href = url; a.download = res.fileName;
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{po.po_no}</h1>
          <p className="text-sm text-gray-500 mt-1">{dualNo}</p>
          {/* 数据链:直达关联订单的生产任务单,采购核对用料/数量(2026-07-03 用户要求) */}
          {(orderRefs || []).length > 0 && (
            <p className="text-xs mt-1 flex flex-wrap gap-2">
              {(orderRefs || []).map((o: any) => (
                <a key={o.id} href={`/orders/${o.id}?tab=manufacturing_order`}
                  className="text-indigo-600 hover:underline">
                  📋 {o.internal_order_no || o.order_no} 生产任务单
                </a>
              ))}
            </p>
          )}
        </div>
        <div className="flex gap-2 shrink-0">
          {canSeeFloor && (
            <button onClick={() => handleExport(true)} disabled={exporting}
              className="text-xs px-3 py-2 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 font-medium disabled:opacity-50">
              {exporting ? '导出中…' : '📥 导出采购单(含价·发供应商)'}
            </button>
          )}
          <button onClick={() => handleExport(false)} disabled={exporting}
            className="text-xs px-3 py-2 rounded-lg bg-sky-50 text-sky-700 border border-sky-200 hover:bg-sky-100 font-medium disabled:opacity-50">
            {exporting ? '导出中…' : '📤 导出无价版(发内部)'}
          </button>
          {canProcure && !['draft', 'cancelled'].includes(po.status) && (
            <button onClick={handleDeposit} disabled={busy === 'deposit'}
              title="货没到先付供应商一笔(定金/预付);走财务付款通道,货到对账自动冲抵"
              className="text-xs px-3 py-2 rounded-lg bg-violet-50 text-violet-700 border border-violet-200 hover:bg-violet-100 font-medium disabled:opacity-50">
              {busy === 'deposit' ? '提交中…' : '💰 申请定金/预付'}
            </button>
          )}
          {isAdmin && (
            <button onClick={handleResync} disabled={busy === 'resync'}
              title="把完整数据重推财务系统,订正旧事件(无供应商/无明细)"
              className="text-xs px-3 py-2 rounded-lg bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100 font-medium disabled:opacity-50">
              {busy === 'resync' ? '重发中…' : '🔄 重发财务同步'}
            </button>
          )}
        </div>
      </div>

      {/* 下单凭证(2026-07-04 用户拍板:下单强制传凭证)—— 草稿态、采购可传 */}
      {po.status === 'draft' && canProcure && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-gray-800">📎 下单凭证</h3>
            {proofPaths.length > 0
              ? <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-medium">已上传 {proofPaths.length} 个</span>
              : <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">未上传 — 下单前必传</span>}
            <label className={`ml-auto text-xs px-3 py-1.5 rounded-lg border border-indigo-200 text-indigo-600 font-medium hover:bg-indigo-50 cursor-pointer ${proofUploading ? 'opacity-50 pointer-events-none' : ''}`}>
              {proofUploading ? '上传中…' : '+ 上传凭证'}
              <input type="file" accept="image/*,.pdf,.xlsx,.xls,.xlsm,.csv,.doc,.docx" multiple className="hidden" disabled={proofUploading}
                onChange={(e) => { if (e.target.files?.length) handleProofUpload(e.target.files); e.currentTarget.value = ''; }} />
            </label>
          </div>
          <p className="text-[11px] text-gray-500 mt-1">发供应商的采购单(Excel/PDF）/ 下单截图 / 付款凭证 / 回单等。下单(placed)前必须至少 1 个。</p>
          {proofPaths.length > 0 && (
            <ul className="mt-2 space-y-1">
              {proofPaths.map((p, i) => (
                <li key={p} className="flex items-center gap-2 text-xs text-gray-600">
                  <span className="truncate flex-1">📄 凭证 {i + 1} · {p.split('/').pop()}</span>
                  <button onClick={() => removeProof(p)} className="text-red-500 hover:underline">删除</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* 辅料附件 / 排版稿(业务在原辅料上传的分款吊卡/箱唛/PDF/AI… + 色卡参考图)——
          采购在此下载 / 预览,连同采购单一起发供应商(2026-07-11)。归并带来的 + BOM 活数据兜底,免手动刷新。 */}
      {(attachFiles.length > 0 || refImages.length > 0) && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-gray-800">📎 辅料附件 / 排版稿</h3>
            <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 font-medium border border-indigo-200">业务上传</span>
          </div>
          <p className="text-[11px] text-gray-500 mt-1">分款吊卡 / 箱唛 / 排版稿(PDF/AI/CDR/xlsx…)与色卡参考图 —— 点「预览」在线看,点「下载」存本地,连同采购单一起发供应商。</p>

          {attachFiles.length > 0 && (
            <ul className="mt-2 space-y-1">
              {attachFiles.map((f, i) => (
                <li key={f.url} className="flex items-center gap-2 text-xs">
                  <span className="truncate flex-1 text-gray-700" title={f.name}>📄 {f.name || `附件 ${i + 1}`}</span>
                  <a href={f.url} target="_blank" rel="noreferrer" className="px-2 py-0.5 rounded border border-indigo-200 text-indigo-600 hover:bg-indigo-50 shrink-0">预览</a>
                  <a href={f.url} download className="px-2 py-0.5 rounded border border-gray-200 text-gray-600 hover:bg-gray-50 shrink-0">下载</a>
                </li>
              ))}
            </ul>
          )}

          {refImages.length > 0 && (
            <div className="mt-3">
              <p className="text-[11px] text-gray-400 mb-1">色卡 / 辅料参考图(点击看大图):</p>
              <div className="flex flex-wrap gap-2">
                {refImages.map((u, i) => (
                  <a key={u} href={u} target="_blank" rel="noreferrer" title={`参考图 ${i + 1}`}
                    className="block w-16 h-16 rounded-lg border border-gray-200 overflow-hidden hover:ring-2 hover:ring-indigo-300">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={u} alt={`参考图 ${i + 1}`} className="w-full h-full object-cover" />
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 审批 / 下单（P2a）—— 卡风险不走流程 */}
      {po.status === 'draft' && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-800">审批 / 下单</h3>
            {po.approval_status === 'pending' ? (
              <p className="text-sm text-amber-700 mt-1">
                ⏳ 待审批 · 触发:{(po.approval_reasons || []).map((r: string) => REASON_LABELS[r] || r).join('、')}
                {' '}· 需 {(po.approval_required_by || []).join(' + ')} 审批
              </p>
            ) : po.approval_status === 'approved' ? (
              <p className="text-sm text-emerald-700 mt-1">✅ 已审批,可下单</p>
            ) : (
              <p className="text-sm text-gray-500 mt-1">草稿 · 点"下单"自动查风险:标准单直接下单,风险单转审批</p>
            )}
            {/* 价格待定(先下单后议价):勾上后允许无底价下单,单上标注。仅采购、仅草稿。 */}
            {po.approval_status !== 'pending' && canProcure && (
              <label className="flex items-center gap-1.5 mt-2 text-xs text-gray-600 cursor-pointer select-none">
                <input type="checkbox" checked={priceTbd} disabled={busy !== ''} onChange={(e) => handleSetPriceTbd(e.target.checked)} />
                <span>价格待定(先下单后议价)—— 勾选后可无底价下单,单上标注 <span className="text-rose-600">「价格待定」</span></span>
              </label>
            )}
            {priceTbd && <span className="inline-block mt-1 text-[11px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 font-medium">🕓 价格待定 · 已允许无价下单</span>}
          </div>
          <div className="flex gap-2 shrink-0">
            {po.approval_status === 'pending' && (canApproveProcurement || canApproveFinance) && (
              <button onClick={handleApprove} disabled={busy !== ''}
                className="text-xs px-4 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 font-medium disabled:opacity-50">
                {busy === 'approve' ? '审批中…' : '✅ 审批通过'}
              </button>
            )}
            {canProcure && po.approval_status !== 'pending' && (
              <button onClick={handlePlace} disabled={busy !== '' || proofPaths.length === 0}
                title={proofPaths.length === 0 ? '请先上传下单凭证' : ''}
                className="text-xs px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 font-medium disabled:opacity-50">
                {busy === 'place' ? '处理中…' : proofPaths.length === 0 ? '📦 下单(先传凭证)' : '📦 下单'}
              </button>
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-white rounded-xl border border-gray-200 p-5 text-sm space-y-1.5">
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold text-gray-800">供应商</h3>
            {canProcure && po.status === 'draft' && (
              <button onClick={() => (supPicker ? setSupPicker(false) : openSupPicker())} disabled={busy === 'supplier'}
                className="text-[11px] px-2 py-1 rounded-lg border border-indigo-200 text-indigo-600 hover:bg-indigo-50 font-medium disabled:opacity-50">
                {busy === 'supplier' ? '修改中…' : supPicker ? '收起' : '✏️ 修改供应商'}
              </button>
            )}
          </div>
          <div className="flex justify-between"><span className="text-gray-500">名称</span><span>{sup.name || '—'}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">联系人</span><span>{sup.contact_name || '—'} {sup.phone || ''}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">付款/账期</span><span>{sup.payment_method || '—'} / {sup.net_days != null ? sup.net_days + '天' : '—'}</span></div>
          {supPicker && (
            <div className="mt-3 pt-3 border-t border-gray-100">
              <input autoFocus value={supQuery} onChange={(e) => setSupQuery(e.target.value)}
                placeholder="搜索供应商(名称 / 联系人 / 电话)…"
                className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-gray-200 focus:border-indigo-300 focus:outline-none" />
              <div className="mt-2 max-h-56 overflow-y-auto space-y-0.5">
                {supLoading && <p className="text-xs text-gray-400 px-1 py-2">加载供应商…</p>}
                {!supLoading && (supList || [])
                  .filter((s: any) => {
                    const q = supQuery.trim().toLowerCase();
                    if (!q) return true;
                    return [s.name, s.contact_name, s.phone].some((f: any) => String(f || '').toLowerCase().includes(q));
                  })
                  .slice(0, 60)
                  .map((s: any) => (
                    <button key={s.id} onClick={() => pickSupplier(s)} disabled={busy === 'supplier'}
                      className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs hover:bg-indigo-50 disabled:opacity-50 ${s.id === po.supplier_id ? 'bg-indigo-50/60' : ''}`}>
                      <span className="font-medium text-gray-800">{s.name}</span>
                      {s.id === po.supplier_id && <span className="ml-1.5 text-[10px] text-indigo-600">· 当前</span>}
                      {(s.contact_name || s.phone) && <span className="text-gray-400 ml-1.5">{s.contact_name || ''} {s.phone || ''}</span>}
                    </button>
                  ))}
                {!supLoading && (supList || []).length > 0 && (supList || []).filter((s: any) => {
                  const q = supQuery.trim().toLowerCase(); if (!q) return true;
                  return [s.name, s.contact_name, s.phone].some((f: any) => String(f || '').toLowerCase().includes(q));
                }).length === 0 && <p className="text-xs text-gray-400 px-1 py-2">无匹配供应商</p>}
              </div>
            </div>
          )}
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-5 text-sm space-y-1.5">
          <h3 className="font-semibold text-gray-800 mb-2">采购单</h3>
          <div className="flex justify-between"><span className="text-gray-500">状态</span><span>{po.status}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">交期</span><span>{po.delivery_date || '—'}</span></div>
          {canSeeFloor && <div className="flex justify-between"><span className="text-gray-500">合计</span><span className="font-semibold">{po.currency} {po.total_amount ?? '—'}</span></div>}
        </div>
      </div>

      {/* 自定义追踪提醒(采购设节点+日期,到点提醒采购/业务/跟单) */}
      <PoRemindersPanel poId={po.id} />

      {/* 采购对账面板已撤(老板 2026-07-11「没用」):对账走「供应商对账台账/收货对账单」页;
          组件 ProcurementReconciliationPanel 保留未删,要恢复加回一行即可 */}

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 text-sm font-semibold text-gray-700 flex items-center gap-2">
          采购行 {lines.length} {!canSeeFloor && <span className="text-xs font-normal text-gray-400">（业务视图:仅建议价）</span>}
          {po.merge_same_materials && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200">
              🔗 合并同料 · 导出时同料并为一行
            </span>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="bg-gray-50 text-left text-gray-500">
              <th className="px-3 py-2">物料</th><th className="px-3 py-2">规格</th>
              <th className="px-3 py-2">颜色</th>
              <th className="px-3 py-2 text-center">尺码</th>
              <th className="px-3 py-2 text-center">订购</th>
              <th className="px-3 py-2 text-center">已收</th>
              <th className="px-3 py-2 text-center">未到</th>
              <th className="px-3 py-2 text-center">状态</th>
              <th className="px-3 py-2 text-right">建议价</th>
              {canSeeFloor && <th className="px-3 py-2 text-right">底价</th>}
              {canSeeFloor && <th className="px-3 py-2 text-right">金额</th>}
              {canEditLines && <th className="px-3 py-2 text-center">操作</th>}
            </tr></thead>
            <tbody className="divide-y divide-gray-100">
              {lines.map((l: any) => {
                const ordered = Number(l.ordered_qty) || 0;
                const received = Number(l.received_qty) || 0;
                const out = Math.max(0, Math.round((ordered - received) * 1000) / 1000);
                const receipts: any[] = Array.isArray(l.receipts) ? l.receipts : [];
                return (
                  <>
                    <tr key={l.id}>
                      <td className="px-3 py-2">{l.material_name}</td>
                      <td className="px-3 py-2 text-gray-500">{l.specification || '—'}</td>
                      <td className="px-3 py-2">{l.color ? <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-700">{l.color}</span> : <span className="text-gray-300">—</span>}</td>
                      <td className="px-3 py-2 text-center">{l.size ? <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-teal-50 text-teal-700">{l.size}</span> : <span className="text-gray-300">—</span>}</td>
                      <td className="px-3 py-2 text-center">{l.ordered_qty} {l.ordered_unit}</td>
                      <td className="px-3 py-2 text-center text-emerald-700 font-medium">{received || '—'}</td>
                      <td className={`px-3 py-2 text-center font-semibold ${out > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>{ordered ? out : '—'}</td>
                      <td className="px-3 py-2 text-center">
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-600">{LINE_STATUS_LABEL[l.line_status] || l.line_status || '—'}</span>
                        {(l.chase_count ?? 0) > 0 && <span className="block text-[10px] text-amber-600 mt-0.5">催{l.chase_count}次{l.last_chased_at ? ` ${String(l.last_chased_at).slice(5, 10)}` : ''}</span>}
                      </td>
                      <td className="px-3 py-2 text-right">{l.price_baseline ?? '—'}</td>
                      {canSeeFloor && <td className="px-3 py-2 text-right font-mono">{l.unit_price ?? '—'}</td>}
                      {canSeeFloor && <td className="px-3 py-2 text-right font-mono">{l.ordered_amount ?? '—'}</td>}
                      {canEditLines && (
                        <td className="px-3 py-2 text-center">
                          <button onClick={() => handleDeleteLine(l)} disabled={busy !== '' || received > 0}
                            title={received > 0 ? '已有收货,不能删除' : '删除此采购行'}
                            className="text-[11px] text-red-500 hover:text-red-700 hover:underline disabled:opacity-40 disabled:no-underline">
                            {busy === 'line:' + l.id ? '删除中…' : '🗑 删除'}
                          </button>
                        </td>
                      )}
                    </tr>
                    {receipts.length > 0 && (
                      <tr key={`${l.id}-receipts`}>
                        <td colSpan={(canSeeFloor ? 11 : 9) + (canEditLines ? 1 : 0)} className="px-3 pb-2 pt-0">
                          <div className="ml-4 rounded-lg bg-emerald-50/60 border border-emerald-100 px-3 py-1.5 text-[11px] text-emerald-800">
                            📥 收货批次:
                            {receipts.map((r: any, i: number) => (
                              <span key={i} className="ml-2">
                                第{i + 1}批 {String(r.received_at || '').slice(0, 10)} · {r.received_qty}{r.received_unit || l.ordered_unit || ''}
                                {r.inspection_result && r.inspection_result !== 'pending' ? `(${r.inspection_result === 'pass' ? '合格' : r.inspection_result === 'concession' ? '让步' : r.inspection_result === 'reject' ? '拒收' : r.inspection_result})` : ''}
                                {i < receipts.length - 1 ? ' ;' : ''}
                              </span>
                            ))}
                            {out > 0 && <b className="ml-2 text-amber-700">· 还差 {out}{l.ordered_unit || ''} 未到</b>}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
            <tfoot><tr className="bg-gray-50 font-medium text-gray-700">
              <td className="px-3 py-2" colSpan={3}>合计</td>
              <td className="px-3 py-2 text-center">{lines.reduce((a: number, l: any) => a + (Number(l.ordered_qty) || 0), 0)}</td>
              <td className="px-3 py-2 text-center text-emerald-700">{lines.reduce((a: number, l: any) => a + (Number(l.received_qty) || 0), 0)}</td>
              <td className="px-3 py-2 text-center text-amber-700">{Math.max(0, Math.round(lines.reduce((a: number, l: any) => a + ((Number(l.ordered_qty) || 0) - (Number(l.received_qty) || 0)), 0) * 1000) / 1000)}</td>
              <td colSpan={(canSeeFloor ? 4 : 2) + (canEditLines ? 1 : 0)} />
            </tr></tfoot>
          </table>
        </div>
      </div>
      {dialog}
    </div>
  );
}

const LINE_STATUS_LABEL: Record<string, string> = {
  draft: '草稿', pending_order: '待下单', ordered: '已下单', confirmed: '已确认',
  in_production: '生产中', ready_to_ship: '待送货', shipped: '在途', arrived: '已送达',
  accepted: '验收合格', concession: '让步接收', rejected: '拒收', completed: '完成', closed: '关闭', cancelled: '已取消',
};
