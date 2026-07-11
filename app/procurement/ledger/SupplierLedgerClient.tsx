'use client';

import { useState, useRef } from 'react';
import { importSupplierLedger, getSupplierLedger, type SupplierGroup, type ImportResult } from '@/app/actions/supplier-ledger';

const yuan = (n: number) => '¥' + (Number(n) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const kg = (n: number | null) => (n == null ? '' : Number(n).toLocaleString('zh-CN'));

export function SupplierLedgerClient({
  initialGroups, initialGrandTotal,
}: { initialGroups: SupplierGroup[]; initialGrandTotal: number }) {
  const [groups, setGroups] = useState<SupplierGroup[]>(initialGroups);
  const [grandTotal, setGrandTotal] = useState(initialGrandTotal);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function reload() {
    const { groups: g, grandTotal: t } = await getSupplierLedger();
    setGroups(g); setGrandTotal(t);
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true); setResult(null);
    const fd = new FormData();
    fd.append('file', file);
    const r = await importSupplierLedger(fd);
    setResult(r);
    setImporting(false);
    if (fileRef.current) fileRef.current.value = '';
    if (r.ok) await reload();
  }

  function toggle(name: string) {
    setOpen((prev) => { const n = new Set(prev); n.has(name) ? n.delete(name) : n.add(name); return n; });
  }

  const totalLines = groups.reduce((s, g) => s + g.lineCount, 0);
  const totalUnbilled = groups.reduce((s, g) => s + g.unbilledCount, 0);

  return (
    <div>
      {/* 导入条 */}
      <div className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-indigo-300 bg-indigo-50/50 p-4">
        <div className="flex-1 min-w-[200px]">
          <div className="text-sm font-semibold text-gray-800">导入《面料采购明细表汇总》</div>
          <div className="text-xs text-gray-500">.xlsx / .xls；每个 sheet 一家供应商。金额按不含税录入。</div>
        </div>
        <input ref={fileRef} type="file" accept=".xlsx,.xls" onChange={onFile} disabled={importing}
          className="text-sm file:mr-3 file:rounded-md file:border-0 file:bg-indigo-600 file:px-4 file:py-2 file:text-white hover:file:bg-indigo-700 disabled:opacity-50" />
        {importing && <span className="text-sm text-indigo-600">导入中…</span>}
      </div>

      {/* 导入结果 */}
      {result && (
        <div className={`mb-6 rounded-lg border p-4 text-sm ${result.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-red-200 bg-red-50 text-red-900'}`}>
          {result.ok ? (
            <div>
              <div className="font-semibold">✓ 导入成功</div>
              <div className="mt-1 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
                <span>供应商 sheet:<b>{result.sheetCount}</b></span>
                <span>明细行:<b>{result.rowCount}</b></span>
                <span>不含税总额:<b>{yuan(result.totalAmount || 0)}</b></span>
                <span>匹配到供应商:<b>{result.matchedSupplier}</b> / 未匹配 <b className={result.unmatchedSupplier ? 'text-amber-700' : ''}>{result.unmatchedSupplier}</b></span>
                <span>匹配到订单:<b>{result.matchedOrder}</b> / 未匹配 <b className={result.unmatchedOrder ? 'text-amber-700' : ''}>{result.unmatchedOrder}</b></span>
              </div>
              {(result.unmatchedSupplier || result.unmatchedOrder) ? (
                <div className="mt-2 text-xs text-amber-700">未匹配的行仍已入库,标为「待关联」;供应商建档 / 订单号规范后可再对上。</div>
              ) : null}
            </div>
          ) : (
            <div><span className="font-semibold">✗ 导入失败:</span> {result.error}</div>
          )}
          {result.warnings && result.warnings.length > 0 && (
            <ul className="mt-2 list-disc pl-5 text-xs text-amber-700">
              {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
        </div>
      )}

      {/* 汇总条 */}
      <div className="mb-4 flex flex-wrap gap-x-8 gap-y-1 rounded-lg bg-gray-50 px-4 py-3 text-sm">
        <span>供应商:<b>{groups.length}</b> 家</span>
        <span>明细:<b>{totalLines}</b> 行</span>
        <span>应付合计(不含税):<b className="text-indigo-700">{yuan(grandTotal)}</b></span>
        {totalUnbilled > 0 && <span className="text-amber-700">未见票:<b>{totalUnbilled}</b> 行</span>}
      </div>

      {groups.length === 0 ? (
        <div className="rounded-lg border border-gray-200 py-16 text-center text-sm text-gray-400">
          还没有台账数据。上传《面料采购明细表汇总》开始。
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => {
            const isOpen = open.has(g.supplier_name_raw);
            return (
              <div key={g.supplier_name_raw} className="overflow-hidden rounded-lg border border-gray-200">
                <button onClick={() => toggle(g.supplier_name_raw)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-gray-50">
                  <span className="text-gray-400">{isOpen ? '▾' : '▸'}</span>
                  <span className="font-semibold text-gray-900">{g.supplier_name_raw}</span>
                  {!g.matched && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700">待关联供应商</span>}
                  {g.unbilledCount > 0 && <span className="rounded bg-orange-100 px-1.5 py-0.5 text-xs text-orange-700">未见票 {g.unbilledCount}</span>}
                  <span className="ml-auto text-sm text-gray-500">{g.lineCount} 行</span>
                  <span className="w-32 text-right font-semibold text-indigo-700">{yuan(g.totalAmount)}</span>
                </button>
                {isOpen && (
                  <div className="overflow-x-auto border-t border-gray-100">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-50 text-gray-500">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium">订单号</th>
                          <th className="px-3 py-2 text-left font-medium">面料</th>
                          <th className="px-3 py-2 text-left font-medium">颜色</th>
                          <th className="px-3 py-2 text-right font-medium">采购KG</th>
                          <th className="px-3 py-2 text-right font-medium">实到KG</th>
                          <th className="px-3 py-2 text-right font-medium">单价</th>
                          <th className="px-3 py-2 text-right font-medium">金额(不含税)</th>
                          <th className="px-3 py-2 text-left font-medium">发票</th>
                          <th className="px-3 py-2 text-left font-medium">备注 / 客户</th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.lines.map((l) => (
                          <tr key={l.id} className="border-t border-gray-50">
                            <td className="px-3 py-1.5">
                              <span className="text-gray-800">{l.order_no_raw || '—'}</span>
                              {l.order_id ? <span className="ml-1 text-emerald-600" title="已匹配系统订单">●</span>
                                : l.internal_order_no ? <span className="ml-1 text-amber-500" title="有内部单号,未匹配到系统订单">○</span> : null}
                            </td>
                            <td className="px-3 py-1.5 text-gray-700">{l.fabric_name || '—'}</td>
                            <td className="px-3 py-1.5 text-gray-700">{l.color || '—'}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{kg(l.ordered_kg)}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{kg(l.received_kg)}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{l.unit_price_ex_tax ?? ''}</td>
                            <td className="px-3 py-1.5 text-right font-medium tabular-nums">{l.amount_ex_tax != null ? yuan(l.amount_ex_tax) : ''}</td>
                            <td className="px-3 py-1.5">
                              {l.invoice_status
                                ? <span className={/没见票|未见票|未收票|无票/.test(l.invoice_status) ? 'text-orange-600' : 'text-gray-500'}>{l.invoice_status}</span>
                                : ''}
                            </td>
                            <td className="px-3 py-1.5 text-gray-400">
                              {l.delivery_note || ''}{l.customer_name ? <span className="ml-1 text-gray-400">· {l.customer_name}</span> : ''}
                            </td>
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
      )}
    </div>
  );
}
