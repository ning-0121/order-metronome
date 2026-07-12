'use client';

import { useState, useRef, useEffect } from 'react';
import {
  importSupplierLedger, getSupplierLedger, setLedgerTaxRate, linkLedgerSupplier,
  linkLedgerOrder, searchOrdersForLink, pushLedgerGroupToFinance,
  getLedgerImports, deleteLedgerImport, clearAllLedger, exportSupplierLedgerExcel,
  type SupplierGroup, type OrderGroup, type ImportResult, type LedgerImportBatch,
} from '@/app/actions/supplier-ledger';
import { listSuppliers } from '@/app/actions/suppliers';
import { useDialogs } from '@/components/ui/useDialogs';

const yuan = (n: number) => '¥' + (Number(n) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const kg = (n: number | null) => (n == null ? '' : Number(n).toLocaleString('zh-CN'));
const pct = (r: number | null) => (r == null ? '—' : `${Math.round(r * 100)}%`);

export function SupplierLedgerClient({
  initialGroups, initialGrandTotalExTax, initialGrandTotalInclTax,
}: { initialGroups: SupplierGroup[]; initialGrandTotalExTax: number; initialGrandTotalInclTax: number }) {
  const { confirm, dialog } = useDialogs();
  const [groups, setGroups] = useState<SupplierGroup[]>(initialGroups);
  const [totalEx, setTotalEx] = useState(initialGrandTotalExTax);
  const [totalIncl, setTotalIncl] = useState(initialGrandTotalInclTax);
  const [openSup, setOpenSup] = useState<Set<string>>(new Set());
  const [openOrd, setOpenOrd] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);
  const [batches, setBatches] = useState<LedgerImportBatch[]>([]);
  const [showBatches, setShowBatches] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { listSuppliers().then((r) => setSuppliers((r.data || []).map((s: any) => ({ id: s.id, name: s.name })))); }, []);
  useEffect(() => { getLedgerImports().then(setBatches); }, []);

  async function reload() {
    const [{ groups: g, grandTotalExTax, grandTotalInclTax }, b] = await Promise.all([getSupplierLedger(), getLedgerImports()]);
    setGroups(g); setTotalEx(grandTotalExTax); setTotalIncl(grandTotalInclTax); setBatches(b);
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true); setResult(null);
    const fd = new FormData(); fd.append('file', file);
    const r = await importSupplierLedger(fd);
    setResult(r); setImporting(false);
    if (fileRef.current) fileRef.current.value = '';
    if (r.ok) await reload();
  }

  async function onDeleteBatch(b: LedgerImportBatch) {
    const ok = await confirm({
      title: '删除这批导入?',
      message: `${b.file_name || '(未命名)'}\n${b.row_count} 行 · ${yuan(b.total_amount_ex_tax)}\n删除后该批所有明细一并移除,可重新上传更正后的表格。`,
      confirmText: '删除', danger: true,
    });
    if (!ok) return;
    setBusy(`delbatch:${b.id}`);
    const r = await deleteLedgerImport(b.id);
    setBusy(null);
    if (!r.ok) { await confirm({ title: '删除失败', message: r.error || '', confirmText: '知道了' }); return; }
    await reload();
  }

  async function doExportLedger(supplierNameRaw?: string) {
    setBusy(supplierNameRaw ? `exp:${supplierNameRaw}` : 'exp:all');
    const r = await exportSupplierLedgerExcel(supplierNameRaw ? { supplierNameRaw } : undefined);
    setBusy(null);
    if (r.error || !r.data) { await confirm({ title: '导出失败', message: r.error || '', confirmText: '知道了' }); return; }
    const bin = atob(r.data.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = r.data.filename; a.click();
    URL.revokeObjectURL(url);
  }

  async function onClearAll() {
    const ok = await confirm({
      title: '清空整个台账?',
      message: '所有导入批次和明细将全部删除(已推财务的行不允许清空)。此操作不可撤销。',
      confirmText: '清空', danger: true,
    });
    if (!ok) return;
    setBusy('clearall');
    const r = await clearAllLedger();
    setBusy(null);
    if (!r.ok) { await confirm({ title: '清空失败', message: r.error || '', confirmText: '知道了' }); return; }
    await reload();
  }

  const toggle = (set: Set<string>, key: string, setter: (s: Set<string>) => void) => {
    const n = new Set(set); n.has(key) ? n.delete(key) : n.add(key); setter(n);
  };

  async function applyTax(supplierNameRaw: string, rate: number | null) {
    setBusy(`tax:${supplierNameRaw}`);
    const r = await setLedgerTaxRate({ supplierNameRaw, rate });
    setBusy(null);
    if (!r.ok) { await confirm({ title: '设税率失败', message: r.error || '', confirmText: '知道了' }); return; }
    await reload();
  }

  async function doLinkSupplier(supplierNameRaw: string, supplierId: string) {
    if (!supplierId) return;
    setBusy(`ls:${supplierNameRaw}`);
    const r = await linkLedgerSupplier(supplierNameRaw, supplierId);
    setBusy(null);
    if (!r.ok) { await confirm({ title: '关联供应商失败', message: r.error || '', confirmText: '知道了' }); return; }
    await reload();
  }

  async function doPush(sup: SupplierGroup, o: OrderGroup) {
    if (!sup.matched) { await confirm({ title: '先关联供应商', message: '该供应商还没关联主数据,先在供应商名旁选择关联,再推财务。', confirmText: '知道了' }); return; }
    const amt = o.amountInclTax || o.amountExTax;
    const ok = await confirm({
      title: '推财务建应付?',
      message: `${sup.supplier_name_raw} · 订单 ${o.order_no_raw}\n${o.lineCount} 行,金额 ${yuan(amt)}(${o.taxRate != null ? `含税 ${pct(o.taxRate)}` : '不含税·未设税率'})\n将生成付款申请并推送财务应付。`,
      confirmText: '推送',
    });
    if (!ok) return;
    setBusy(`push:${sup.supplier_name_raw}|${o.order_no_raw}`);
    const r = await pushLedgerGroupToFinance({ supplierNameRaw: sup.supplier_name_raw, orderNoRaw: o.order_no_raw });
    setBusy(null);
    if (!r.ok) { await confirm({ title: '推财务失败', message: r.error || '', confirmText: '知道了' }); return; }
    await confirm({ title: '已推财务', message: `付款申请 ${r.billNo}\n金额 ${yuan(r.amount || 0)} 已推送财务应付。`, confirmText: '知道了' });
    await reload();
  }

  // ── 批量推财务:勾选订单组(仅未推的可选)→ 一键批量推(2026-07-11 用户:每单前加可选 + 全选) ──
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const ordKeyOf = (supRaw: string, ordRaw: string) => `${supRaw}|${ordRaw}`;
  const selectableKeys = (g: SupplierGroup) => g.orders.filter((o) => !o.pushed).map((o) => ordKeyOf(g.supplier_name_raw, o.order_no_raw));
  const allSelectable = groups.flatMap(selectableKeys);
  const toggleSel = (key: string) => setSelected((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const toggleSupSel = (g: SupplierGroup) => setSelected((s) => {
    const keys = selectableKeys(g); const n = new Set(s);
    const allOn = keys.length > 0 && keys.every((k) => n.has(k));
    for (const k of keys) { if (allOn) n.delete(k); else n.add(k); }
    return n;
  });
  const selCount = selected.size;
  const selAmount = groups.reduce((sum, g) => sum + g.orders.reduce((a, o) =>
    a + (selected.has(ordKeyOf(g.supplier_name_raw, o.order_no_raw)) ? (o.amountInclTax || o.amountExTax || 0) : 0), 0), 0);

  async function doBatchPush() {
    // 组装选中项;供应商未关联的挡下来(单推同样规则)
    const items: { sup: SupplierGroup; o: OrderGroup }[] = [];
    const unmatchedSups = new Set<string>();
    for (const g of groups) for (const o of g.orders) {
      if (!selected.has(ordKeyOf(g.supplier_name_raw, o.order_no_raw)) || o.pushed) continue;
      if (!g.matched) { unmatchedSups.add(g.supplier_name_raw); continue; }
      items.push({ sup: g, o });
    }
    if (unmatchedSups.size > 0) {
      await confirm({ title: '有供应商未关联', message: `以下供应商还没关联主数据,其选中订单本次不能推:\n${[...unmatchedSups].join('、')}\n请先在供应商名旁关联,或取消勾选后继续。`, confirmText: '知道了' });
      if (items.length === 0) return;
    }
    if (items.length === 0) return;
    const ok = await confirm({
      title: `批量推财务(${items.length} 单)?`,
      message: `将逐单生成付款申请并推送财务应付:\n${items.slice(0, 8).map(({ sup, o }) => `· ${sup.supplier_name_raw} ${o.order_no_raw} ${yuan(o.amountInclTax || o.amountExTax)}`).join('\n')}${items.length > 8 ? `\n…等共 ${items.length} 单` : ''}\n合计 ${yuan(items.reduce((a, { o }) => a + (o.amountInclTax || o.amountExTax || 0), 0))}`,
      confirmText: '批量推送',
    });
    if (!ok) return;
    setBusy('batchpush');
    const fails: string[] = []; let okCount = 0;
    for (const { sup, o } of items) {   // 逐单串行:每单独立建应付,失败不影响其余
      const r = await pushLedgerGroupToFinance({ supplierNameRaw: sup.supplier_name_raw, orderNoRaw: o.order_no_raw });
      if (r.ok) okCount++; else fails.push(`${sup.supplier_name_raw} ${o.order_no_raw}: ${r.error || '失败'}`);
    }
    setBusy(null);
    setSelected(new Set());
    await reload();
    await confirm({
      title: `批量推送完成:成功 ${okCount} / 失败 ${fails.length}`,
      message: fails.length ? `失败明细:\n${fails.join('\n')}\n(成功的已建应付;失败的修正后可重推)` : '全部付款申请已推送财务应付。',
      confirmText: '知道了',
    });
  }

  const totalLines = groups.reduce((s, g) => s + g.lineCount, 0);
  const totalUnbilled = groups.reduce((s, g) => s + g.unbilledCount, 0);

  return (
    <div>
      {dialog}
      {/* 导入条 */}
      <div className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-indigo-300 bg-indigo-50/50 p-4">
        <div className="flex-1 min-w-[200px]">
          <div className="text-sm font-semibold text-gray-800">导入《面料采购明细表汇总》</div>
          <div className="text-xs text-gray-500">.xlsx / .xls；每个 sheet 一家供应商。金额按不含税录入,税率后设。</div>
        </div>
        <input ref={fileRef} type="file" accept=".xlsx,.xls" onChange={onFile} disabled={importing}
          className="text-sm file:mr-3 file:rounded-md file:border-0 file:bg-indigo-600 file:px-4 file:py-2 file:text-white hover:file:bg-indigo-700 disabled:opacity-50" />
        {importing && <span className="text-sm text-indigo-600">导入中…</span>}
      </div>

      {/* 导入记录 / 删除重传 */}
      {batches.length > 0 && (
        <div className="mb-6 rounded-lg border border-gray-200">
          <div className="flex items-center gap-2 px-4 py-2">
            <button onClick={() => setShowBatches((v) => !v)} className="flex items-center gap-1.5 text-sm text-gray-600">
              <span className="text-gray-400">{showBatches ? '▾' : '▸'}</span>
              导入记录 <span className="text-gray-400">({batches.length} 批)</span>
            </button>
            <span className="ml-auto text-xs text-gray-400">传错了?删掉整批,重新上传更正后的表格</span>
            <button onClick={onClearAll} disabled={busy === 'clearall'}
              className="rounded border border-red-200 px-2 py-0.5 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50">
              {busy === 'clearall' ? '清空中…' : '清空台账'}
            </button>
          </div>
          {showBatches && (
            <div className="divide-y divide-gray-100 border-t border-gray-100">
              {batches.map((b) => (
                <div key={b.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-xs">
                  <span className="font-medium text-gray-700">{b.file_name || '(未命名)'}</span>
                  <span className="text-gray-400">{new Date(b.created_at).toLocaleString('zh-CN', { hour12: false })}</span>
                  <span className="text-gray-500">{b.sheet_count} 供应商 · {b.row_count} 行 · {yuan(b.total_amount_ex_tax)}</span>
                  {b.pushed_count > 0 && <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700">已推财务 {b.pushed_count} 行</span>}
                  <span className="ml-auto">
                    {b.pushed_count > 0
                      ? <span className="text-gray-300" title="有已推财务的行,不能删">🔒 不可删</span>
                      : <button onClick={() => onDeleteBatch(b)} disabled={busy === `delbatch:${b.id}`}
                          className="text-red-600 hover:underline disabled:opacity-50">
                          {busy === `delbatch:${b.id}` ? '删除中…' : '删除本批'}
                        </button>}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {result && (
        <div className={`mb-6 rounded-lg border p-4 text-sm ${result.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-red-200 bg-red-50 text-red-900'}`}>
          {result.ok ? (
            <div>
              <div className="font-semibold">✓ 导入成功</div>
              <div className="mt-1 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
                <span>供应商 sheet:<b>{result.sheetCount}</b></span>
                <span>明细行:<b>{result.rowCount}</b></span>
                <span>不含税总额:<b>{yuan(result.totalAmount || 0)}</b></span>
                <span>匹配供应商:<b>{result.matchedSupplier}</b> / 未匹配 <b className={result.unmatchedSupplier ? 'text-amber-700' : ''}>{result.unmatchedSupplier}</b></span>
                <span>匹配订单:<b>{result.matchedOrder}</b> / 未匹配 <b className={result.unmatchedOrder ? 'text-amber-700' : ''}>{result.unmatchedOrder}</b></span>
              </div>
              {(result.unmatchedSupplier || result.unmatchedOrder) ? (
                <div className="mt-2 text-xs text-amber-700">未匹配的行仍已入库,标「待关联」;下方可手动关联供应商 / 订单。</div>
              ) : null}
            </div>
          ) : (<div><span className="font-semibold">✗ 导入失败:</span> {result.error}</div>)}
        </div>
      )}

      {/* 汇总条 */}
      <div className="mb-4 flex flex-wrap gap-x-8 gap-y-1 rounded-lg bg-gray-50 px-4 py-3 text-sm">
        <span>供应商:<b>{groups.length}</b> 家</span>
        <span>明细:<b>{totalLines}</b> 行</span>
        <span>不含税合计:<b>{yuan(totalEx)}</b></span>
        <span>含税合计:<b className="text-indigo-700">{yuan(totalIncl)}</b></span>
        {totalUnbilled > 0 && <span className="text-amber-700">未见票:<b>{totalUnbilled}</b> 行</span>}
        <button onClick={() => doExportLedger()} disabled={busy === 'exp:all' || groups.length === 0}
          className="ml-auto rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
          {busy === 'exp:all' ? '导出中…' : '📥 导出台账 Excel'}
        </button>
      </div>

      {groups.length === 0 ? (
        <div className="rounded-lg border border-gray-200 py-16 text-center text-sm text-gray-400">
          还没有台账数据。上传《面料采购明细表汇总》开始。
        </div>
      ) : (
        <div className="space-y-3">
          {/* 批量推财务操作条:有可推订单时常显;勾选后显示合计并可一键批量推 */}
          {allSelectable.length > 0 && (
            <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 rounded-lg border border-indigo-200 bg-indigo-50/90 px-4 py-2.5 backdrop-blur">
              <label className="flex items-center gap-1.5 text-sm text-gray-700 cursor-pointer select-none">
                <input type="checkbox"
                  checked={selCount > 0 && selCount === allSelectable.length}
                  ref={(el) => { if (el) el.indeterminate = selCount > 0 && selCount < allSelectable.length; }}
                  onChange={() => setSelected(selCount === allSelectable.length ? new Set() : new Set(allSelectable))} />
                全选(未推 {allSelectable.length} 单)
              </label>
              {selCount > 0 ? (
                <>
                  <span className="text-sm text-indigo-800">已选 <b>{selCount}</b> 单 · 含税合计 <b>{yuan(selAmount)}</b></span>
                  <button onClick={doBatchPush} disabled={busy === 'batchpush'}
                    className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
                    {busy === 'batchpush' ? '批量推送中…' : `🚀 批量推财务(${selCount})`}
                  </button>
                  <button onClick={() => setSelected(new Set())} className="text-xs text-gray-500 hover:text-gray-700">清除勾选</button>
                </>
              ) : (
                <span className="text-xs text-gray-500">勾选订单组后可一键批量推财务(已推/未关联供应商的不可选)</span>
              )}
            </div>
          )}
          {groups.map((g) => {
            const supOpen = openSup.has(g.supplier_name_raw);
            const supSelectable = selectableKeys(g);
            const supAllOn = supSelectable.length > 0 && supSelectable.every((k) => selected.has(k));
            const supSomeOn = supSelectable.some((k) => selected.has(k));
            return (
              <div key={g.supplier_name_raw} className="overflow-hidden rounded-lg border border-gray-200">
                {/* 供应商头 */}
                <div className="flex flex-wrap items-center gap-2 px-4 py-3">
                  {supSelectable.length > 0 && (
                    <input type="checkbox" checked={supAllOn}
                      ref={(el) => { if (el) el.indeterminate = !supAllOn && supSomeOn; }}
                      onChange={() => toggleSupSel(g)}
                      title="全选该供应商未推财务的订单" className="cursor-pointer" />
                  )}
                  <button onClick={() => toggle(openSup, g.supplier_name_raw, setOpenSup)} className="flex items-center gap-2 text-left">
                    <span className="text-gray-400">{supOpen ? '▾' : '▸'}</span>
                    <span className="font-semibold text-gray-900">{g.supplier_name_raw}</span>
                  </button>
                  {g.matched
                    ? <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-700">已关联</span>
                    : (
                      <span className="flex items-center gap-1">
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700">待关联</span>
                        <select disabled={busy === `ls:${g.supplier_name_raw}`} defaultValue=""
                          onChange={(e) => doLinkSupplier(g.supplier_name_raw, e.target.value)}
                          className="rounded border border-gray-300 px-1.5 py-0.5 text-xs">
                          <option value="">关联到…</option>
                          {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                      </span>
                    )}
                  {g.unbilledCount > 0 && <span className="rounded bg-orange-100 px-1.5 py-0.5 text-xs text-orange-700">未见票 {g.unbilledCount}</span>}
                  <button onClick={() => doExportLedger(g.supplier_name_raw)} disabled={busy === `exp:${g.supplier_name_raw}`}
                    className="ml-auto rounded border border-emerald-300 px-2 py-0.5 text-xs text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
                    title="导出这家供应商的对账台账 Excel">
                    {busy === `exp:${g.supplier_name_raw}` ? '…' : '📥 导出'}
                  </button>
                  <span className="text-sm text-gray-400">{g.lineCount} 行</span>
                  <span className="w-28 text-right text-sm text-gray-500">不含税 {yuan(g.totalExTax)}</span>
                  <span className="w-32 text-right font-semibold text-indigo-700">含税 {yuan(g.totalInclTax)}</span>
                </div>

                {supOpen && (
                  <div className="border-t border-gray-100 bg-gray-50/50 px-4 py-3">
                    {/* 设税率 */}
                    <TaxSetter supplierNameRaw={g.supplier_name_raw} busy={busy === `tax:${g.supplier_name_raw}`} onApply={applyTax} />

                    {/* 订单分组 */}
                    <div className="mt-3 space-y-2">
                      {g.orders.map((o) => {
                        const ordKey = `${g.supplier_name_raw}|${o.order_no_raw}`;
                        const ordOpen = openOrd.has(ordKey);
                        return (
                          <div key={ordKey} className="rounded-md border border-gray-200 bg-white">
                            <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                              {!o.pushed && (
                                <input type="checkbox" checked={selected.has(ordKey)} onChange={() => toggleSel(ordKey)}
                                  title="勾选后可在顶部批量推财务" className="cursor-pointer" />
                              )}
                              <button onClick={() => toggle(openOrd, ordKey, setOpenOrd)} className="flex items-center gap-1.5 text-left">
                                <span className="text-gray-400 text-xs">{ordOpen ? '▾' : '▸'}</span>
                                <span className="text-sm font-medium text-gray-800">{o.order_no_raw}</span>
                              </button>
                              {o.order_id ? <span className="text-emerald-600 text-xs" title="已匹配系统订单">● 已匹配</span>
                                : <OrderLinker supplierNameRaw={g.supplier_name_raw} orderNoRaw={o.order_no_raw} onLinked={reload} disabled={o.pushed} />}
                              <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">税率 {pct(o.taxRate)}</span>
                              <span className="ml-auto text-xs text-gray-400">{o.lineCount} 行</span>
                              <span className="w-24 text-right text-xs text-gray-500">{yuan(o.amountExTax)}</span>
                              <span className="w-28 text-right text-sm font-semibold text-gray-800">{yuan(o.amountInclTax)}</span>
                              {o.pushed
                                ? <span className="rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-700 whitespace-nowrap" title="已推财务">✓ {o.payableBillNo}</span>
                                : <button onClick={() => doPush(g, o)} disabled={busy === `push:${ordKey}`}
                                    className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50 whitespace-nowrap">
                                    {busy === `push:${ordKey}` ? '推送中…' : '推财务'}
                                  </button>}
                            </div>
                            {ordOpen && (
                              <div className="overflow-x-auto border-t border-gray-100">
                                <table className="w-full text-xs">
                                  <thead className="bg-gray-50 text-gray-500">
                                    <tr>
                                      <th className="px-3 py-1.5 text-left font-medium">面料</th>
                                      <th className="px-3 py-1.5 text-left font-medium">颜色</th>
                                      <th className="px-3 py-1.5 text-right font-medium">采购KG</th>
                                      <th className="px-3 py-1.5 text-right font-medium">实到KG</th>
                                      <th className="px-3 py-1.5 text-right font-medium">单价</th>
                                      <th className="px-3 py-1.5 text-right font-medium">不含税</th>
                                      <th className="px-3 py-1.5 text-right font-medium">含税</th>
                                      <th className="px-3 py-1.5 text-left font-medium">发票</th>
                                      <th className="px-3 py-1.5 text-left font-medium">备注/客户</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {o.lines.map((l) => (
                                      <tr key={l.id} className="border-t border-gray-50">
                                        <td className="px-3 py-1.5 text-gray-700">{l.fabric_name || '—'}</td>
                                        <td className="px-3 py-1.5 text-gray-700">{l.color || '—'}</td>
                                        <td className="px-3 py-1.5 text-right tabular-nums">{kg(l.ordered_kg)}</td>
                                        <td className="px-3 py-1.5 text-right tabular-nums">{kg(l.received_kg)}</td>
                                        <td className="px-3 py-1.5 text-right tabular-nums">{l.unit_price_ex_tax ?? ''}</td>
                                        <td className="px-3 py-1.5 text-right tabular-nums">{l.amount_ex_tax != null ? yuan(l.amount_ex_tax) : ''}</td>
                                        <td className="px-3 py-1.5 text-right font-medium tabular-nums">{l.amount_incl_tax != null ? yuan(l.amount_incl_tax) : ''}</td>
                                        <td className="px-3 py-1.5">{l.invoice_status ? <span className={/没见票|未见票|未收票|无票/.test(l.invoice_status) ? 'text-orange-600' : 'text-gray-500'}>{l.invoice_status}</span> : ''}</td>
                                        <td className="px-3 py-1.5 text-gray-400">{l.delivery_note || ''}{l.customer_name ? ` · ${l.customer_name}` : ''}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** 设税率(供应商级,应用到该供应商所有未推行)。 */
function TaxSetter({ supplierNameRaw, busy, onApply }: { supplierNameRaw: string; busy: boolean; onApply: (s: string, r: number | null) => void }) {
  const [val, setVal] = useState('13');
  return (
    <div className="flex items-center gap-2 text-xs text-gray-600">
      <span>设税率(应用到该供应商未推财务的行):</span>
      <select value={val} onChange={(e) => setVal(e.target.value)} className="rounded border border-gray-300 px-1.5 py-0.5">
        <option value="13">13%</option>
        <option value="9">9%</option>
        <option value="6">6%</option>
        <option value="3">3%</option>
        <option value="0">0%</option>
        <option value="clear">清空</option>
      </select>
      <button onClick={() => onApply(supplierNameRaw, val === 'clear' ? null : Number(val) / 100)} disabled={busy}
        className="rounded bg-gray-800 px-2 py-0.5 text-white hover:bg-gray-700 disabled:opacity-50">
        {busy ? '…' : '应用'}
      </button>
    </div>
  );
}

/** 关联订单(搜内部单号/客户/款号)。 */
function OrderLinker({ supplierNameRaw, orderNoRaw, onLinked, disabled }: { supplierNameRaw: string; orderNoRaw: string; onLinked: () => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [opts, setOpts] = useState<{ id: string; label: string }[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    const t = setTimeout(async () => { setOpts(await searchOrdersForLink(q)); setLoading(false); }, 250);
    return () => clearTimeout(t);
  }, [q, open]);

  if (disabled) return <span className="text-amber-500 text-xs" title="未匹配系统订单">○ 待关联</span>;
  return (
    <span className="relative">
      <button onClick={() => setOpen((v) => !v)} className="text-xs text-amber-600 underline decoration-dotted">○ 关联订单</button>
      {open && (
        <div className="absolute z-10 mt-1 w-72 rounded-md border border-gray-200 bg-white p-2 shadow-lg">
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜内部单号/客户/款号"
            className="mb-1 w-full rounded border border-gray-300 px-2 py-1 text-xs" />
          <div className="max-h-48 overflow-y-auto">
            {loading ? <div className="py-2 text-center text-xs text-gray-400">搜索中…</div>
              : opts.length === 0 ? <div className="py-2 text-center text-xs text-gray-400">无结果</div>
              : opts.map((o) => (
                <button key={o.id} onClick={async () => { await linkLedgerOrder({ supplierNameRaw, orderNoRaw, orderId: o.id }); setOpen(false); onLinked(); }}
                  className="block w-full truncate rounded px-2 py-1 text-left text-xs hover:bg-indigo-50">{o.label}</button>
              ))}
          </div>
        </div>
      )}
    </span>
  );
}
