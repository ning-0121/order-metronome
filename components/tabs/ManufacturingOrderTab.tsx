'use client';
import { useEffect, useState } from 'react';
import {
  getManufacturingOrder, upsertManufacturingOrder, updateManufacturingOrderStatus,
  generateProductionOrderSheet, generateTrimSheet,
} from '@/app/actions/manufacturing-order';
import { LineItemMatrixEditor } from '@/components/order/LineItemMatrixEditor';
import { OrderShareDocsLinks } from '@/components/OrderShareDocsLinks';
import { orderSizeKeys, sizeComparator } from '@/lib/utils/size-sort';
import { useDialogs } from '@/components/ui/useDialogs';
import { base64ToBlob, triggerBlobDownload } from '@/lib/browser/download';
import { commercialQuantityFromLine } from '@/lib/domain/quantity-engine';

const CAT_LABEL: Record<string, string> = {
  fabric: '面料', trim: '辅料', lining: '里料', label: '标签', packing: '包装',
  print: '印花', washing: '水洗', embroidery: '绣花', service: '服务', other: '其他',
};
const STATUS_FLOW = [
  { key: 'draft', label: '草稿' }, { key: 'reviewing', label: '复核中' },
  { key: 'confirmed', label: '已确认' }, { key: 'executing', label: '已下发生产' }, { key: 'closed', label: '完成' },
];
const statusLabel = (s: string) => STATUS_FLOW.find(x => x.key === s)?.label || s;
// 步骤条只画真实可达的 4 步 —— 「复核中」是遗留死状态(无 UI 入口),不再画格子误导用户以为漏了一步。
const VISIBLE_STEPS = [
  { key: 'draft', label: '草稿' }, { key: 'confirmed', label: '已确认' },
  { key: 'executing', label: '已下发生产' }, { key: 'closed', label: '完成' },
];
// 状态 → 进度序;reviewing 视同尚未确认(与「确认」按钮对 draft/reviewing 同显一致)。
const STATUS_RANK: Record<string, number> = { draft: 0, reviewing: 0, confirmed: 1, executing: 2, closed: 3 };

const emptyForm = {
  print_embroidery_requirements: '', qc_focus: '', special_requirements: '',
  risk_notes: '', factory_packing_instructions: '', factory_notes: '',
};

export function ManufacturingOrderTab({ orderId }: { orderId: string }) {
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [generating, setGenerating] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [downloadDiagnostic, setDownloadDiagnostic] = useState<any | null>(null);
  const { confirm, dialog } = useDialogs();

  const reload = async () => {
    const res = await getManufacturingOrder(orderId);
    if ((res as any).error) { setMsg((res as any).error); setLoading(false); return; }
    const d = (res as any).data;
    setData(d);
    if (d.mo) {
      setForm({
        print_embroidery_requirements: d.mo.print_embroidery_requirements || '',
        qc_focus: d.mo.qc_focus || '', special_requirements: d.mo.special_requirements || '',
        risk_notes: d.mo.risk_notes || '', factory_packing_instructions: d.mo.factory_packing_instructions || '',
        factory_notes: d.mo.factory_notes || '',
      });
    }
    setLoading(false);
  };
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [orderId]);

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  async function save() {
    setSaving(true); setMsg('');
    const res = await upsertManufacturingOrder(orderId, form);
    setSaving(false);
    if ((res as any).error) { setMsg('保存失败：' + (res as any).error); return; }
    setMsg('✅ 已保存');
    await reload();
  }

  async function advance(status: string, successMsg: string) {
    setStatusBusy(true); setStatusMsg('');
    const res = await updateManufacturingOrderStatus(orderId, status as any);
    setStatusBusy(false);
    if ((res as any).error) { setStatusMsg('❌ ' + (res as any).error); return; }
    await reload();
    setStatusMsg(successMsg);
  }

  // 确认:内容无误 → 已确认(例行动作,一键 + 反馈,不弹确认)
  const confirmContent = () => advance('confirmed', '✅ 已确认,可下发生产');

  // 下发生产:关键动作(通知生产、自动完成下发节点)—— 弹二次确认并说明影响,防误点。
  async function dispatch() {
    const ok = await confirm({
      title: '确认下发生产?',
      message: '下发后:\n· 生产任务单进入「已下发生产」\n· 自动完成「生产任务单下发」节点\n· 通知生产开工\n\n请先确认逐款明细与工厂执行说明无误(下发后改动需重新沟通生产)。',
      confirmText: '确认下发',
    });
    if (!ok) return;
    await advance('executing', '🏭 已下发生产,已通知生产');
  }

  // 完成:关键动作(关单)—— 弹二次确认。
  async function complete() {
    const ok = await confirm({
      title: '标记完成?',
      message: '标记完成后本生产任务单关闭。请确认大货生产已实际完成。',
      confirmText: '确认完成',
    });
    if (!ok) return;
    await advance('closed', '✅ 生产任务单已完成');
  }

  // 两张单独出:'production'=生产订单(第一张,款式主表),'trim'=辅料单(第二张,辅料明细)
  async function generate(kind: 'production' | 'trim') {
    setGenerating(true); setMsg('');
    try {
      if (kind === 'production') {
        const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/production-task/download`, { credentials: 'include', cache: 'no-store' });
        if (!response.ok) { const body = await response.json().catch(() => ({})); setMsg(`下载失败：${body.error || `HTTP ${response.status}`}`); return; }
        const blob = await response.blob();
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const fileSignature = String.fromCharCode(bytes[0] || 0, bytes[1] || 0);
        setDownloadDiagnostic({ actionInvoked: false, orderId, productionTaskId: data?.mo?.id || null, generator: 'binary route handler', returnedFilename: response.headers.get('content-disposition') || null, returnedMimeType: response.headers.get('content-type'), base64Length: 0, decodedByteLength: bytes.length, fileSignature, triggerBlobDownloadReached: true, browserDownloadInvoked: true, error: null });
        if (!bytes.length || fileSignature !== 'PK') { setMsg('下载失败：二进制响应不是有效 XLSX 文件'); return; }
        const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `生产任务单_${orderId}.xlsx`; document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url); return;
      }
      const res = kind === 'production'
        ? await generateProductionOrderSheet(orderId)
        : await generateTrimSheet(orderId);
      if ((res as any).error) { setMsg((res as any).error); return; }
      const { base64, fileName } = res as any;
      const binary = base64 ? atob(base64) : '';
      const decodedByteLength = binary.length;
      const fileSignature = binary.slice(0, 2) === 'PK' ? 'PK' : binary.slice(0, 2) || '—';
      setDownloadDiagnostic({ actionInvoked: true, orderId, productionTaskId: data?.mo?.id || null, generator: (res as any).generator || '—', sheetCount: (res as any).sheetCount || '—', generationMs: (res as any).generationMs || '—', returnedFilename: fileName || null, returnedMimeType: (res as any).mimeType || null, base64Length: base64?.length || 0, decodedByteLength, fileSignature, triggerBlobDownloadReached: false, browserDownloadInvoked: false, error: null });
      if (kind === 'production' && (!base64 || typeof base64 !== 'string' || base64.length < 1000 || !/QM-20260717-002|1022222/i.test(String(fileName || '')))) {
        setMsg('下载失败：服务端未返回当前订单的有效生产任务单文件'); return;
      }
      if (kind === 'production' && fileSignature !== 'PK') { setMsg('下载失败：返回内容不是有效 XLSX 文件'); return; }
      setDownloadDiagnostic((d: any) => d ? { ...d, triggerBlobDownloadReached: true, browserDownloadInvoked: true } : d);
      triggerBlobDownload(base64ToBlob(base64), fileName);
    } catch (e: any) { setMsg('生成出错：' + (e?.message || e)); }
    finally { setGenerating(false); }
  }

  if (loading) return <div className="text-center py-8 text-gray-400">加载中...</div>;
  if (!data) return <div className="text-center py-8 text-red-500">{msg || '加载失败'}</div>;

  const { mo, order, lineItems, bom, quantityContext } = data;
  const commercialQty = quantityContext?.commercialQuantity ?? order.quantity;
  const physicalQty = quantityContext?.physicalQuantity ?? order.quantity;
  const piecesPerSet = quantityContext?.componentsPerCommercialUnit ?? 1;
  const headerQuantityValue = commercialQty;
  const headerQuantityUnit = piecesPerSet > 1 ? '套' : (order.quantity_unit || '件');
  const displayedProductionQuantity = physicalQty;
  const status = mo?.status || null;

  const field = (label: string, key: keyof typeof emptyForm, ph = '', rows = 2) => (
    <label className="text-xs text-gray-600 block">{label}
      <textarea value={form[key]} onChange={e => set(key, e.target.value)} placeholder={ph} rows={rows}
        className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm resize-y" />
    </label>
  );

  return (
      <div className="space-y-5">
      <div className="rounded border border-indigo-200 bg-indigo-50 p-2 text-[11px] text-indigo-900">
        PR39_BUILD_SHA=52aaef68fa87fa027e9208e55c722215230aff6 · environment=Preview · RENDER_COMPONENT=components/tabs/ManufacturingOrderTab.tsx · RENDER_VERSION=PR39-V2
        <div>orders.quantity={order.quantity} · orders.quantity_unit={order.quantity_unit || '—'} · line_qty_sum={lineItems.reduce((n: number, l: any) => n + (Number(l.qty_pcs) || 0), 0)} · set_multiplier={piecesPerSet}</div>
        <div>commercialQuantity={commercialQty} · physicalPieceQuantity={physicalQty} · piecesPerSet={piecesPerSet} · headerQuantityValue={headerQuantityValue} · headerQuantityUnit={headerQuantityUnit} · displayedProductionQuantity={displayedProductionQuantity} · boundOrderQuantityValue={commercialQty} · boundOrderQuantityUnit={headerQuantityUnit} · styleSubtotalValue={commercialQty} · styleSubtotalUnit={headerQuantityUnit} · productionTaskRecordId={mo?.id || '—'} · status={mo?.status || '—'} · version={mo?.updated_at || '—'}</div>
      </div>
      {downloadDiagnostic && <div className="rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-900">下载诊断：action invoked={String(downloadDiagnostic.actionInvoked)} · orderId={downloadDiagnostic.orderId} · productionTaskId={downloadDiagnostic.productionTaskId || '—'} · generator={downloadDiagnostic.generator} · sheets={downloadDiagnostic.sheetCount} · ms={downloadDiagnostic.generationMs} · filename={downloadDiagnostic.returnedFilename || '—'} · mime={downloadDiagnostic.returnedMimeType || '—'} · base64={downloadDiagnostic.base64Length} · bytes={downloadDiagnostic.decodedByteLength} · signature={downloadDiagnostic.fileSignature} · triggerBlobDownload={String(downloadDiagnostic.triggerBlobDownloadReached)} · browser download={String(downloadDiagnostic.browserDownloadInvoked)}{downloadDiagnostic.error ? ` · error=${downloadDiagnostic.error}` : ''}</div>}
      {/* 顶部:MO 号 + 生命周期 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm">
          <span className="font-mono font-semibold text-gray-900">{mo?.mo_no || '生产任务单（未创建）'}</span>
          {status && <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700">{statusLabel(status)}</span>}
        </div>
        <div className="flex gap-2">
          <button onClick={() => setPreviewing(true)} disabled={!mo}
            className="text-sm px-3 py-1.5 rounded-lg bg-white text-gray-700 border border-gray-300 font-medium hover:bg-gray-50 disabled:opacity-50">
            👁 预览</button>
          <button onClick={() => generate('production')} disabled={generating}
            className="text-sm px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-medium hover:bg-emerald-700 disabled:opacity-50"
            title="第一张:款式主表。建单即可下载,不用等辅料确认">
            {generating ? '生成中…' : '📄 下载生产任务单'}</button>
          <button onClick={() => generate('trim')} disabled={generating}
            className="text-sm px-3 py-1.5 rounded-lg bg-teal-600 text-white font-medium hover:bg-teal-700 disabled:opacity-50"
            title="第二张:辅料明细。读最新 BOM,包装辅料确认后再下载">
            {generating ? '生成中…' : '🧵 下载辅料单'}</button>
        </div>
      </div>

      {/* 预览弹窗:按范本版式渲染(数据与下载的 Excel 同源) */}
      {previewing && (
        <MoSheetPreview order={order} mo={{ ...mo, ...form }} lineItems={lineItems} bom={bom}
          onClose={() => setPreviewing(false)} onDownload={() => { setPreviewing(false); generate('production'); }} />
      )}

      {/* S1 富明细录入(款/色/码/件数)—— 录/改在此,下方生成任务单读它 */}
      <div className="bg-gray-50/60 rounded-xl border border-gray-200 p-3">
        <div className="text-sm font-semibold text-gray-800 mb-2">逐款明细(款 / 颜色 / 尺码 × 件数)</div>
        <p className="text-[11px] text-gray-400 mb-3">这里录/改逐款明细,是生产任务单和客户 PI 的数据源。手工录,或修正 AI 解析 PO 的结果。</p>
        <LineItemMatrixEditor orderId={orderId} />
      </div>

      {/* 订单共享文件(辅料采购清单/包装方式,业务在「原辅料和包装」上传)*/}
      <OrderShareDocsLinks orderId={orderId} />

      {/* AI 原始识别冻结底档(建单时 PO 解析原文,纠错追溯用) */}
      <PoParseSnapshotPanel orderId={orderId} />

      {/* 生命周期条 */}
      {mo && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {VISIBLE_STEPS.map((s, i) => {
            const rank = STATUS_RANK[status] ?? 0;
            const done = i <= rank;
            const current = i === rank;
            return (
              <span key={s.key} className="flex items-center gap-1.5">
                <span className={`text-xs px-2 py-0.5 rounded-full ${done ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-400'} ${current ? 'ring-2 ring-indigo-300' : ''}`}>{s.label}</span>
                {i < VISIBLE_STEPS.length - 1 && <span className="text-gray-300">›</span>}
              </span>
            );
          })}
          <span className="ml-auto flex items-center gap-3">
            {statusMsg && <span className="text-xs text-gray-500">{statusBusy ? '处理中…' : statusMsg}</span>}
            {(status === 'draft' || status === 'reviewing') && (
              <button onClick={confirmContent} disabled={statusBusy}
                className="text-sm px-4 py-2 rounded-lg bg-indigo-600 text-white font-semibold shadow-sm hover:bg-indigo-700 disabled:opacity-50">
                {statusBusy ? '处理中…' : '✅ 确认'}</button>
            )}
            {status === 'confirmed' && (
              <button onClick={dispatch} disabled={statusBusy}
                className="text-sm px-4 py-2 rounded-lg bg-amber-600 text-white font-semibold shadow-sm hover:bg-amber-700 disabled:opacity-50">
                {statusBusy ? '处理中…' : '🏭 下发生产'}</button>
            )}
            {status === 'executing' && (
              <button onClick={complete} disabled={statusBusy}
                className="text-sm px-4 py-2 rounded-lg bg-emerald-600 text-white font-semibold shadow-sm hover:bg-emerald-700 disabled:opacity-50">
                {statusBusy ? '处理中…' : '✔ 完成'}</button>
            )}
          </span>
        </div>
      )}

      {/* Customer Order 绑定(只读,单一真相不复制)*/}
      <div className="rounded-xl border border-gray-200 p-4 bg-gray-50/50">
        <div className="text-xs font-semibold text-gray-500 mb-2">客户订单（绑定 · 只读）</div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-1.5 text-sm">
          <div><span className="text-gray-400">客户：</span>{order.customer_name || '—'}</div>
          <div><span className="text-gray-400">订单号：</span>{order.order_no || '—'}</div>
          <div><span className="text-gray-400">款号：</span>{order.style_no || '—'}</div>
          <div><span className="text-gray-400">产品：</span>{order.product_description || '—'}</div>
          <div><span className="text-gray-400">订单数量：</span>{commercialQty ?? '—'} {piecesPerSet > 1 ? '套' : (order.quantity_unit || '件')}</div>
          <div><span className="text-gray-400">生产件数：</span>{physicalQty ?? '—'} 件 · {piecesPerSet} 件/套</div>
          <div><span className="text-gray-400">工厂交期：</span>{order.factory_date ? String(order.factory_date).slice(0, 10) : '—'}</div>
        </div>
        {order.packaging_type && (
          <div className="mt-2 text-xs text-gray-500"><span className="text-gray-400">包装类型：</span>{order.packaging_type === 'standard' ? '标准' : '定制'}</div>
        )}
      </div>

      {/* 款色码 + 原辅料包摘要 */}
      <div className="grid md:grid-cols-2 gap-4">
        <div className="rounded-xl border border-gray-200 p-3">
          <div className="text-xs font-semibold text-gray-500 mb-2">款 × 色 × 码（{lineItems.length}）</div>
          {lineItems.length === 0 ? <p className="text-xs text-gray-400">无明细</p> : (
            <div className="space-y-1 text-xs max-h-40 overflow-y-auto">
              {lineItems.map((li: any, i: number) => (
                <div key={i} className="flex gap-2">
                  <span className="text-gray-700 shrink-0">{[li.color_cn, li.color_en].filter(Boolean).join('/') || '—'}</span>
                  <span className="text-gray-400 truncate">{li.sizes && typeof li.sizes === 'object' ? Object.entries(li.sizes).sort((a, b) => sizeComparator(order?.size_order)(a[0], b[0])).map(([k, v]) => `${k}:${v}`).join(' ') : ''}</span>
                  <span className="ml-auto text-gray-600 shrink-0">{li.qty_pcs ?? '—'} {li.unit || ''}{Number(li.set_multiplier) > 1 ? `（${commercialQuantityFromLine(li.qty_pcs, li.set_multiplier)} 套）` : ''}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="rounded-xl border border-gray-200 p-3">
          <div className="text-xs font-semibold text-gray-500 mb-2">原辅料包（{bom.length}）</div>
          {bom.length === 0 ? <p className="text-xs text-gray-400">无明细（去「原辅料和包装」录入）</p> : (
            <div className="space-y-1 text-xs max-h-40 overflow-y-auto">
              {bom.map((b: any, i: number) => (
                <div key={i} className="flex gap-2">
                  <span className="font-medium text-gray-800 shrink-0">{b.material_name}</span>
                  <span className="text-blue-600 shrink-0">{CAT_LABEL[b.material_type] || b.material_type}</span>
                  <span className="text-gray-400 truncate">{b.color || ''} {b.placement || ''}</span>
                  <span className="ml-auto text-gray-600 shrink-0">{b.qty_per_piece ?? '—'} {b.unit || ''}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* MO 录入字段(业务翻译给工厂执行)*/}
      <div className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-4 space-y-3">
        <div className="text-xs font-semibold text-gray-600">工厂执行说明（业务翻译，结构化录入）</div>
        <div className="grid md:grid-cols-2 gap-3">
          {/* 标签与「生产任务单」Excel 行一一对齐(2026-07-10):字段 key 不变,只改显示名,避免误填。
              缝制要求←print_embroidery_requirements / 检验要求←qc_focus / 包装要求←factory_packing_instructions
              / 注意事项←risk_notes / 裁剪要求←factory_notes(见 manufacturing-order.ts 生成行) */}
          {field('缝制要求', 'print_embroidery_requirements')}
          {field('检验要求（QC 重点）', 'qc_focus')}
          {field('特殊要求', 'special_requirements')}
          {field('注意事项', 'risk_notes')}
          {field('包装要求（内部，≠客户原始要求）', 'factory_packing_instructions')}
          {field('裁剪要求', 'factory_notes')}
        </div>
        <div className="flex items-center gap-3">
          <button onClick={save} disabled={saving}
            className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
            {saving ? '保存中…' : mo ? '保存' : '创建生产任务单'}</button>
          {msg && <span className="text-xs text-gray-500">{msg}</span>}
        </div>
      </div>
      {dialog}
    </div>
  );
}

/** 生产任务单预览 —— V2 版式(每款一页),数据与下载 Excel 同源。 */
function MoSheetPreview({ order, mo, lineItems, bom, onClose, onDownload }: {
  order: any; mo: any; lineItems: any[]; bom: any[]; onClose: () => void; onDownload: () => void;
}) {
  // 按款分组(与服务端生成同口径)
  const groups: { style_no: string; product_name: string; image_url: string; items: any[] }[] = [];
  for (const li of lineItems) {
    const key = li.style_no || order.style_no || '';
    let g = groups.find(x => x.style_no === key);
    if (!g) { g = { style_no: key, product_name: li.product_name || order.product_description || '', image_url: li.image_url || '', items: [] }; groups.push(g); }
    if (!g.image_url && li.image_url) g.image_url = li.image_url;
    g.items.push(li);
  }
  if (groups.length === 0) groups.push({ style_no: order.style_no || '', product_name: order.product_description || '', image_url: '', items: [] });

  const joinTxt = (...vs: any[]) => vs.filter(Boolean).join('；');
  const today = new Date().toISOString().slice(0, 10);
  const fmtD = (v: any) => (v ? String(v).slice(0, 10) : '');
  const bomSorted = [...bom].sort((a: any, b: any) => (a.material_type === 'fabric' ? 0 : 1) - (b.material_type === 'fabric' ? 0 : 1));

  const td = 'border border-gray-400 px-2 py-1 text-center align-middle';
  const tdL = 'border border-gray-400 px-2 py-1 text-left align-middle';
  const secCls = 'bg-gray-100 border border-gray-400 px-2 py-1 text-left font-bold';

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-xl max-w-5xl w-full my-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-white rounded-t-xl border-b border-gray-200 px-4 py-3 flex items-center justify-between z-10">
          <span className="text-sm font-semibold text-gray-800">👁 生产任务单预览 · QIMO 生产任务单标准模板 V1.0（{groups.length} 款）</span>
          <div className="flex gap-2">
            <button onClick={onDownload} className="text-xs px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-medium hover:bg-emerald-700">📄 下载 Excel</button>
            <button onClick={onClose} className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50">关闭</button>
          </div>
        </div>

        <div className="p-4 space-y-10">
          {groups.map((g, gi) => {
            const sizeSet = new Set<string>();
            for (const li of g.items) if (li.sizes && typeof li.sizes === 'object') for (const k of Object.keys(li.sizes)) sizeSet.add(k);
            const sizeKeys = orderSizeKeys([...sizeSet], order?.size_order).slice(0, 8);
            const styleTotal = groups.length === 1 ? commercialQty : g.items.reduce((a, li) => a + commercialQuantityFromLine(li.qty_pcs, li.set_multiplier), 0);
            const colTotals = sizeKeys.map(s => g.items.reduce((a, li) => a + ((li.sizes && Number(li.sizes[s])) || 0), 0));
            // 与下载 Excel 逐行同源(manufacturing-order.ts 生成行);此前 preview 用了不同映射,导致预览≠成品单
            const reqRows: [string, string][] = [
              ['裁剪要求', mo.factory_notes || ''],
              ['缝制要求', mo.print_embroidery_requirements || ''],
              ['检验要求', mo.qc_focus || ''],
              ['包装要求', mo.factory_packing_instructions || ''],
              ['装箱要求', ''],
              ['注意事项', mo.risk_notes || mo.special_requirements || ''],
            ];
            const nCols = Math.max(sizeKeys.length, 1) + 5;
            // S1.2 按款过滤 BOM:该款专属(含同步布料) + 整单通用
            const bomForStyle = bomSorted.filter((b: any) => !b.style_no || b.style_no === g.style_no);
            return (
              <div key={gi} className="text-[13px] text-gray-900" style={{ fontFamily: 'SimSun, 宋体, serif' }}>
                <div className="text-center text-xl font-bold">义乌市绮陌服饰有限公司</div>
                <div className="text-center text-base font-bold mb-2">生 产 任 务 单</div>

                {/* 订单头 */}
                <table className="w-full border-collapse">
                  <tbody>
                    <tr>
                      <td className={`${td} w-24 font-bold`}>订单号</td><td className={tdL}>{order.order_no || '—'}</td>
                      <td className={`${td} w-20 font-bold`}>客户</td><td className={tdL}>{order.customer_name || '—'}</td>
                      <td className={`${td} w-24 font-bold`}>下单日期</td><td className={tdL}>{fmtD(order.order_date) || '—'}</td>
                    </tr>
                    <tr>
                      <td className={`${td} font-bold`}>款号</td><td className={`${tdL} font-bold`}>{g.style_no || '—'}</td>
                      <td className={`${td} font-bold`}>品名</td><td className={tdL}>{g.product_name || '—'}</td>
                      <td className={`${td} font-bold`}>该款数量</td><td className={tdL}>{styleTotal ? `${styleTotal}件` : '—'}</td>
                    </tr>
                    <tr>
                      <td className={`${td} font-bold`}>工厂交期</td><td className={tdL}>{fmtD(order.factory_date) || '—'}</td>
                      <td className={`${td} font-bold`}>发货(ETD)</td><td className={tdL}>{fmtD(order.etd) || '—'}</td>
                      <td className={`${td} font-bold`}>制单日期</td><td className={tdL}>{today}</td>
                    </tr>
                  </tbody>
                </table>

                {/* 一、订单数量明细 */}
                <table className="w-full border-collapse mt-3">
                  <tbody>
                    <tr><td className={secCls} colSpan={nCols}>一、订单数量明细</td></tr>
                    <tr>
                      <td className={`${td} font-bold`}>颜色</td>
                      {sizeKeys.map(s => <td key={s} className={`${td} font-bold`}>{s}</td>)}
                      {sizeKeys.length === 0 && <td className={td}></td>}
                      <td className={`${td} font-bold`}>合计</td>
                      <td className={`${td} font-bold`}>每箱件数</td>
                      <td className={`${td} font-bold`}>箱数</td>
                      <td className={`${td} font-bold w-48`}>客户包装</td>
                    </tr>
                    {g.items.map((li, ci) => (
                      <tr key={ci}>
                        <td className={td}>{[li.color_cn, li.color_en].filter(Boolean).join('/') || '—'}</td>
                        {sizeKeys.map(s => <td key={s} className={td}>{(li.sizes && Number(li.sizes[s])) || ''}</td>)}
                        {sizeKeys.length === 0 && <td className={td}></td>}
                        <td className={`${td} font-bold`}>{sizeKeys.reduce((a, s) => a + ((li.sizes && Number(li.sizes[s])) || 0), 0) || ''}</td>
                        <td className={`${td} text-gray-300`}>手填</td>
                        <td className={`${td} text-gray-300`}>自动</td>
                        <td className={`${tdL} text-xs`}>{li.remark || ''}</td>
                      </tr>
                    ))}
                    {g.items.length === 0 && <tr><td className={`${td} text-gray-400`} colSpan={nCols}>（无逐款明细,先在「逐款明细」录入）</td></tr>}
                    {g.items.length > 0 && (
                      <tr>
                        <td className={`${td} font-bold`}>总计</td>
                        {colTotals.map((t, i) => <td key={i} className={`${td} font-bold`}>{t || ''}</td>)}
                        {sizeKeys.length === 0 && <td className={td}></td>}
                        <td className={`${td} font-bold`}>{styleTotal || ''}</td>
                        <td className={td}></td><td className={td}></td><td className={td}></td>
                      </tr>
                    )}
                  </tbody>
                </table>
                <p className="text-[11px] text-gray-400 mt-0.5">「每箱件数」下载后手填,「箱数」Excel 自动算（=合计÷每箱件数）。</p>

                {/* 二、用料单耗 */}
                <table className="w-full border-collapse mt-3">
                  <tbody>
                    <tr><td className={secCls} colSpan={6}>二、用料单耗</td></tr>
                    <tr>
                      <td className={`${td} font-bold`}>物料</td><td className={`${td} font-bold w-16`}>类别</td>
                      <td className={`${td} font-bold w-20`}>颜色</td><td className={`${td} font-bold w-20`}>单耗/件</td>
                      <td className={`${td} font-bold w-14`}>单位</td><td className={`${td} font-bold`}>备注</td>
                    </tr>
                    {bomForStyle.length > 0 ? bomForStyle.map((b: any, i: number) => (
                      <tr key={i}>
                        <td className={tdL}>{b.material_name}</td>
                        <td className={td}>{CAT_LABEL[b.material_type] || b.material_type}</td>
                        <td className={td}>{b.color || ''}</td>
                        <td className={td}>{b.qty_per_piece ?? ''}</td>
                        <td className={td}>{b.unit || ''}</td>
                        <td className={`${tdL} text-xs`}>{joinTxt(b.placement, b.special_requirements)}</td>
                      </tr>
                    )) : (
                      <tr><td className={`${td} text-gray-400`} colSpan={6}>（未录 BOM;在「原辅料和包装」录入后自动带出,Excel 中留白手填）</td></tr>
                    )}
                  </tbody>
                </table>

                {/* 三、装箱·包装·工艺要求 */}
                <table className="w-full border-collapse mt-3">
                  <tbody>
                    <tr><td className={secCls} colSpan={2}>三、装箱 · 包装 · 工艺要求</td></tr>
                    {reqRows.map(([label, text], i) => (
                      <tr key={i}>
                        <td className={`${td} w-28 font-bold whitespace-nowrap`}>{label}</td>
                        <td className={`${tdL} ${text ? '' : 'text-gray-300'}`}>{text || '（留白手填）'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {/* 四、尺寸表 + 产品图 */}
                <div className="mt-3 flex gap-3 items-start">
                  <div className="flex-1">
                    <div className={secCls}>四、尺寸表（单位：CM · 按上传的尺码表填写,Excel 中留空格）</div>
                    <div className="border border-t-0 border-gray-400 px-2 py-3 text-gray-400 text-xs">
                      部位 × {sizeKeys.length > 0 ? sizeKeys.join(' / ') : '尺码'} × 公差 —— 共 10 行留白,下载后按尺码表填写
                    </div>
                  </div>
                  <div className="w-48 border border-gray-400 min-h-[100px] flex items-center justify-center">
                    {g.image_url
                      ? <img src={g.image_url} alt="产品图" className="max-h-48 object-contain" />
                      : <span className="text-gray-400 text-xs">（未上传产品图）</span>}
                  </div>
                </div>

                <div className="mt-2 text-xs">抄送:采购、面料仓、辅料仓{order.factory_name ? `、${order.factory_name}` : ''}、QC、包装组长、打包组长</div>
                <div className="flex gap-16 mt-1">
                  <span>制单：</span><span>跟单：</span><span>批准：</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** AI 原始识别冻结底档面板:折叠展示建单时 PO 解析原文,可「用当前明细覆盖冻结」(再冻结)。 */
function PoParseSnapshotPanel({ orderId }: { orderId: string }) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [snap, setSnap] = useState<any>(null);
  const [at, setAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function load() {
    const { getPoParseSnapshot } = await import('@/app/actions/order-line-items');
    const res = await getPoParseSnapshot(orderId);
    setSnap((res as any).snapshot || null);
    setAt((res as any).at || null);
    setLoaded(true);
  }
  async function toggle() {
    const next = !open; setOpen(next);
    if (next && !loaded) await load();
  }
  async function refreeze() {
    if (!confirm('用当前「逐款明细」覆盖冻结底档?覆盖后底档 = 现在的明细。')) return;
    setBusy(true); setMsg('');
    const { refreezePoParseSnapshot } = await import('@/app/actions/order-line-items');
    const res = await refreezePoParseSnapshot(orderId);
    setBusy(false);
    if ((res as any).error) { setMsg('❌ ' + (res as any).error); return; }
    setMsg('✅ 已重新冻结'); await load();
  }

  const styles = snap?.styles || [];
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-3">
      <button onClick={toggle} className="w-full flex items-center justify-between text-sm font-semibold text-gray-800">
        <span>📋 AI 原始识别（冻结底档）{at && <span className="ml-2 text-[11px] font-normal text-gray-400">冻结于 {String(at).slice(0, 16).replace('T', ' ')}</span>}</span>
        <span className="text-gray-400">{open ? '收起 ▲' : '展开 ▼'}</span>
      </button>
      {open && (
        <div className="mt-3">
          {!loaded ? <p className="text-xs text-gray-400">加载中…</p>
            : !snap ? <p className="text-xs text-gray-400">此单无 PO 解析底档(手工录入或从 PO 创建的单没有 AI 原文)。</p>
            : (
            <>
              <p className="text-[11px] text-gray-500 mb-2">这是建单时 AI 从 PO 读出的原文(只读)。和上方「逐款明细」对比可看当初读错在哪;纠正在上方明细里改,改完点下面「再冻结」把底档更新成现在的明细。</p>
              <div className="overflow-x-auto border border-gray-100 rounded-lg">
                <table className="w-full text-xs">
                  <thead><tr className="bg-gray-50 text-gray-500 text-left">
                    {['款号', '品名', '颜色', '尺码×件数'].map(h => <th key={h} className="px-2 py-1.5 font-medium">{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {styles.flatMap((st: any, si: number) => (st.colors || []).map((c: any, ci: number) => (
                      <tr key={`${si}-${ci}`} className="border-t border-gray-50">
                        <td className="px-2 py-1">{ci === 0 ? (st.style_no || '—') : ''}</td>
                        <td className="px-2 py-1 text-gray-500">{ci === 0 ? (st.product_name || '—') : ''}</td>
                        <td className="px-2 py-1">{[c.color_cn, c.color_en].filter(Boolean).join('/') || '—'}</td>
                        <td className="px-2 py-1 text-gray-600">{Object.entries(c.sizes || {}).map(([k, v]) => `${k}:${v}`).join('  ') || '—'}</td>
                      </tr>
                    )))}
                    {styles.length === 0 && <tr><td colSpan={4} className="px-2 py-2 text-gray-400">（底档无款色码）</td></tr>}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center gap-3 mt-2">
                <button onClick={refreeze} disabled={busy}
                  className="text-xs px-3 py-1.5 rounded-lg border border-indigo-300 text-indigo-700 font-medium hover:bg-indigo-50 disabled:opacity-50">
                  {busy ? '处理中…' : '🔒 用当前明细再冻结'}</button>
                {msg && <span className="text-xs text-gray-600">{msg}</span>}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
