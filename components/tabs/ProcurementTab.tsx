'use client';

import { useState, useEffect } from 'react';
import {
  getProcurementItems,
  addProcurementItem,
  recordReceipt,
  deleteProcurementItem,
  exportReconciliationSheet,
  syncFromProcurementTracking,
  type ProcurementLineItem,
} from '@/app/actions/procurement';
import { useDialogs } from '@/components/ui/useDialogs';

interface Props {
  orderId: string;
  isAdmin: boolean;
  canEdit: boolean;        // 可以添加/删除采购明细（merchandiser/procurement/sales/admin）
  canRecordReceipt: boolean; // 只有跟单/admin 可录入实到数量
}

const CATEGORY_OPTIONS = [
  { value: 'fabric', label: '面料' },
  { value: 'lining', label: '里料' },
  { value: 'trim', label: '辅料' },
  { value: 'label', label: '标签' },
  { value: 'zipper', label: '拉链' },
  { value: 'button', label: '纽扣' },
  { value: 'elastic', label: '松紧' },
  { value: 'packing', label: '包材' },
  { value: 'other', label: '其他' },
];

const CATEGORY_LABELS: Record<string, string> = Object.fromEntries(CATEGORY_OPTIONS.map(o => [o.value, o.label]));

export function ProcurementTab({ orderId, isAdmin, canEdit, canRecordReceipt }: Props) {
  const { confirm, dialog } = useDialogs();
  const [items, setItems] = useState<ProcurementLineItem[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingReceiptId, setEditingReceiptId] = useState<string | null>(null);
  const [receiptQty, setReceiptQty] = useState('');
  const [receiptNotes, setReceiptNotes] = useState('');
  const [exporting, setExporting] = useState(false);
  const [syncing, setSyncing] = useState(false);

  // 新增表单
  const [formName, setFormName] = useState('');
  const [formSpec, setFormSpec] = useState('');
  const [formSupplier, setFormSupplier] = useState('');
  const [formCategory, setFormCategory] = useState('fabric');
  const [formQty, setFormQty] = useState('');
  const [formUnit, setFormUnit] = useState('KG');
  const [formPrice, setFormPrice] = useState('');
  const [formQtyPerPiece, setFormQtyPerPiece] = useState(''); // 辅料单件用量
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => { load(); }, [orderId]);

  async function load() {
    setLoading(true);
    const res = await getProcurementItems(orderId);
    if (res.data) setItems(res.data);
    if (res.summary) setSummary(res.summary);
    setLoading(false);
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!formName || !formQty) return;
    setSubmitting(true);
    const res = await addProcurementItem(orderId, {
      material_name: formName,
      specification: formSpec || undefined,
      supplier_name: formSupplier || undefined,
      category: formCategory,
      ordered_qty: Number(formQty),
      ordered_unit: formUnit,
      unit_price: formPrice ? Number(formPrice) : undefined,
      qty_per_piece: formQtyPerPiece ? Number(formQtyPerPiece) : undefined,
    });
    if (res.error) {
      await confirm({ title: res.error, confirmText: '知道了' });
    } else {
      if (res.warning) {
        await confirm({ title: '⚠ 预算预警', message: res.warning, confirmText: '知道了' });
      }
      setFormName(''); setFormSpec(''); setFormQty(''); setFormPrice(''); setFormQtyPerPiece('');
      setShowAddForm(false);
      load();
    }
    setSubmitting(false);
  }

  async function handleRecordReceipt(itemId: string) {
    if (!receiptQty) return;
    const res = await recordReceipt(itemId, orderId, Number(receiptQty), receiptNotes || undefined);
    if (res.error) await confirm({ title: res.error, confirmText: '知道了' });
    else {
      setEditingReceiptId(null);
      setReceiptQty('');
      setReceiptNotes('');
      load();
    }
  }

  async function handleDelete(item: any) {
    const ids: string[] = item?.line_ids?.length ? item.line_ids : [item.id];
    if (!(await confirm({ title: ids.length > 1 ? `删除这条采购明细(含 ${ids.length} 个拆码行)？` : '删除这条采购明细？', danger: true, confirmText: '删除' }))) return;
    for (const id of ids) await deleteProcurementItem(id, orderId);
    load();
  }

  async function handleSync() {
    if (!(await confirm({ title: '从采购进度同步数据到对账明细？', message: '已存在的物料会跳过，不会重复添加。', confirmText: '同步' }))) return;
    setSyncing(true);
    const res = await syncFromProcurementTracking(orderId);
    if (res.error && res.added === 0) {
      await confirm({ title: res.error, confirmText: '知道了' });
    } else {
      await confirm({ title: '同步完成 ✅', message: `新增 ${res.added} 条，跳过 ${res.skipped} 条（已存在）`, confirmText: '知道了' });
      load();
    }
    setSyncing(false);
  }

  async function handleExport() {
    setExporting(true);
    const res = await exportReconciliationSheet(orderId);
    if (res.error) { await confirm({ title: res.error, confirmText: '知道了' }); setExporting(false); return; }
    if (res.base64 && res.fileName) {
      const byteChars = atob(res.base64);
      const byteNums = new Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) byteNums[i] = byteChars.charCodeAt(i);
      const blob = new Blob([new Uint8Array(byteNums)], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = res.fileName;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(url);
    }
    setExporting(false);
  }

  if (loading) return <div className="text-center py-8 text-gray-400 text-sm">加载中...</div>;

  return (
    <div className="space-y-5">
      {/* 汇总卡片 */}
      {summary && summary.itemCount > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <div className="bg-white rounded-lg border border-gray-200 p-3 text-center">
            <div className="text-lg font-bold text-gray-800">{summary.itemCount}</div>
            <div className="text-xs text-gray-500">采购项</div>
          </div>
          <div className="bg-white rounded-lg border border-amber-200 p-3 text-center" title="面料逐行预算(单价×量) + 辅料整单一口价">
            <div className="text-lg font-bold text-amber-600">¥{(summary.budgetTotal || 0).toLocaleString()}</div>
            <div className="text-xs text-gray-500">预算总额</div>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-3 text-center">
            <div className="text-lg font-bold text-indigo-600">¥{summary.totalOrdered.toLocaleString()}</div>
            <div className="text-xs text-gray-500">订购总额</div>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-3 text-center">
            <div className="text-lg font-bold text-emerald-600">¥{summary.totalReceived.toLocaleString()}</div>
            <div className="text-xs text-gray-500">实收总额</div>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-3 text-center">
            <div className={`text-lg font-bold ${summary.totalDifference === 0 ? 'text-gray-500' : summary.totalDifference < 0 ? 'text-red-600' : 'text-amber-600'}`}>
              ¥{summary.totalDifference.toLocaleString()}
            </div>
            <div className="text-xs text-gray-500">差异金额</div>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-3 text-center">
            <div className={`text-lg font-bold ${summary.discrepancyCount === 0 ? 'text-green-600' : 'text-red-600'}`}>
              {summary.discrepancyCount}
            </div>
            <div className="text-xs text-gray-500">异常项（&gt;3%）</div>
          </div>
        </div>
      )}

      {/* 操作栏 */}
      <div className="flex items-center gap-2 flex-wrap">
        {canEdit && (
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 font-medium"
          >
            + 添加采购明细
          </button>
        )}
        {canEdit && (
          <button
            onClick={handleSync}
            disabled={syncing}
            className="text-xs px-3 py-1.5 rounded-lg bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100 font-medium disabled:opacity-50"
          >
            {syncing ? '同步中...' : '🔄 从采购进度同步'}
          </button>
        )}
        {items.length > 0 && (
          <button
            onClick={handleExport}
            disabled={exporting}
            className="text-xs px-3 py-1.5 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 font-medium disabled:opacity-50"
          >
            {exporting ? '导出中...' : '📥 导出对账单 Excel'}
          </button>
        )}
      </div>

      {/* 添加表单 */}
      {showAddForm && (
        <form onSubmit={handleAdd} className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-4 space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <input value={formName} onChange={e => setFormName(e.target.value)} placeholder="物料名称 *" required className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            <input value={formSpec} onChange={e => setFormSpec(e.target.value)} placeholder="规格（幅宽/克重/颜色）" className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            <input value={formSupplier} onChange={e => setFormSupplier(e.target.value)} placeholder="供应商" className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            <select value={formCategory} onChange={e => setFormCategory(e.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white">
              {CATEGORY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <input type="number" step="0.01" value={formQty} onChange={e => setFormQty(e.target.value)} placeholder="订购数量 *" required className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            <select value={formUnit} onChange={e => setFormUnit(e.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white">
              <option value="KG">KG</option><option value="M">米</option><option value="PCS">件/个</option><option value="ROLL">卷</option><option value="SET">套</option>
            </select>
            <input type="number" step="0.001" value={formPrice} onChange={e => setFormPrice(e.target.value)} placeholder="单价 ¥" className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            <input type="number" step="0.01" value={formQtyPerPiece} onChange={e => setFormQtyPerPiece(e.target.value)} placeholder="单件用量（选填）" className="rounded-lg border border-amber-300 px-3 py-2 text-sm" title="每件成品用多少这个辅料（例如：标签 2 个/件）" />
          </div>
          {formQtyPerPiece && Number(formQtyPerPiece) > 0 && (
            <p className="text-xs text-amber-600">
              💡 单件用量 {formQtyPerPiece} × 订单数量 × 1.03 损耗 = 预算，到货时自动对比
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setShowAddForm(false)} className="text-xs px-3 py-1.5 text-gray-500 hover:bg-gray-100 rounded-lg">取消</button>
            <button type="submit" disabled={submitting} className="text-xs px-4 py-1.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 font-medium">
              {submitting ? '添加中...' : '添加'}
            </button>
          </div>
        </form>
      )}

      {/* 对账表格 */}
      {items.length === 0 ? (
        <div className="text-center py-12 text-gray-400 text-sm">
          暂无采购明细。在"采购下单"节点完成时录入订购数据。
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 text-left">
                  <th className="px-3 py-2 font-medium text-gray-600">物料</th>
                  <th className="px-3 py-2 font-medium text-gray-600">规格</th>
                  <th className="px-3 py-2 font-medium text-gray-600">供应商</th>
                  <th className="px-3 py-2 font-medium text-gray-600 text-center">类别</th>
                  <th className="px-3 py-2 font-medium text-gray-500 text-right">单件用量</th>
                  <th className="px-3 py-2 font-medium text-amber-600 text-right" title="面料预算单价(业务在采购核料录);辅料预算为整单一口价,见上方「预算总额」">预算单价</th>
                  <th className="px-3 py-2 font-medium text-indigo-600 text-right">订购数量</th>
                  <th className="px-3 py-2 font-medium text-gray-600 text-center">单位</th>
                  <th className="px-3 py-2 font-medium text-gray-600 text-right">单价</th>
                  <th className="px-3 py-2 font-medium text-emerald-600 text-right">实收数量</th>
                  <th className="px-3 py-2 font-medium text-red-600 text-right">差异</th>
                  <th className="px-3 py-2 font-medium text-red-600 text-right">差异%</th>
                  <th className="px-3 py-2 font-medium text-gray-600">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {items.map(item => {
                  const hasDiscrepancy = item.received_qty !== null && Math.abs(item.difference_pct || 0) > 3;
                  const isEditingReceipt = editingReceiptId === item.id;
                  const merged = ((item as any).size_count || 1) > 1;   // 拆码行已合并显示
                  return (
                    <tr key={item.id} className={hasDiscrepancy ? 'bg-red-50' : ''}>
                      <td className="px-3 py-2 font-medium text-gray-900">
                        {item.material_name}
                        {(item as any).color && <span className="ml-1 text-[10px] text-gray-400">{(item as any).color}</span>}
                        {(item as any).sizes?.length > 0 && <span className="ml-1 text-[10px] px-1 py-0.5 rounded bg-teal-50 text-teal-700 font-medium" title="该料按尺码采购,已合并;数量为合计">尺码 {(item as any).sizes.join('·')}</span>}
                      </td>
                      <td className="px-3 py-2 text-gray-500">{item.specification || '-'}</td>
                      <td className="px-3 py-2 text-gray-500">{item.supplier_name || '-'}</td>
                      <td className="px-3 py-2 text-center">
                        <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
                          {CATEGORY_LABELS[item.category] || item.category}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-gray-400">{(item as any).qty_per_piece || '-'}</td>
                      <td className="px-3 py-2 text-right font-mono text-amber-600" title={(item as any).budget_unit_price != null ? '面料预算单价(业务在采购核料录)' : '辅料预算为整单一口价,见上方「预算总额」'}>
                        {(item as any).budget_unit_price != null ? `¥${Number((item as any).budget_unit_price).toLocaleString()}` : '—'}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-indigo-700">{item.ordered_qty}</td>
                      <td className="px-3 py-2 text-center text-gray-500">{item.ordered_unit}</td>
                      <td className="px-3 py-2 text-right font-mono">{item.unit_price ?? '-'}</td>
                      <td className="px-3 py-2 text-right">
                        {isEditingReceipt ? (
                          <div className="flex items-center gap-1 justify-end">
                            <input
                              type="number"
                              step="0.01"
                              value={receiptQty}
                              onChange={e => setReceiptQty(e.target.value)}
                              placeholder="实收"
                              className="w-20 rounded border border-emerald-300 px-2 py-1 text-right text-xs"
                              autoFocus
                            />
                            <button onClick={() => handleRecordReceipt(item.id)} className="text-emerald-600 hover:text-emerald-700 font-medium">✓</button>
                            <button onClick={() => setEditingReceiptId(null)} className="text-gray-400 hover:text-gray-600">✕</button>
                          </div>
                        ) : (
                          <span className={`font-mono ${item.received_qty !== null ? 'text-emerald-700' : 'text-gray-300'}`}>
                            {item.received_qty ?? (
                              merged ? <span className="text-gray-400 text-[11px]" title="拆码行合并显示,收货请在采购中心「收货登记」(单一真相)">采购中心收</span>
                              : canRecordReceipt ? (
                                <button
                                  onClick={() => { setEditingReceiptId(item.id); setReceiptQty(String(item.ordered_qty)); }}
                                  className="text-emerald-500 hover:text-emerald-700 hover:underline"
                                >
                                  录入 →
                                </button>
                              ) : '未收'
                            )}
                          </span>
                        )}
                      </td>
                      <td className={`px-3 py-2 text-right font-mono ${hasDiscrepancy ? 'text-red-600 font-bold' : 'text-gray-500'}`}>
                        {item.difference_qty ?? '-'}
                      </td>
                      <td className={`px-3 py-2 text-right font-mono ${hasDiscrepancy ? 'text-red-600 font-bold' : 'text-gray-500'}`}>
                        {item.difference_pct !== null ? `${item.difference_pct}%` : '-'}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex gap-1">
                          {canRecordReceipt && !merged && item.received_qty === null && !isEditingReceipt && (
                            <button
                              onClick={() => { setEditingReceiptId(item.id); setReceiptQty(String(item.ordered_qty)); }}
                              className="text-emerald-500 hover:text-emerald-700"
                              title="录入实收"
                            >
                              📥
                            </button>
                          )}
                          {(isAdmin || canEdit) && (
                            <button
                              onClick={() => handleDelete(item)}
                              className="text-gray-300 hover:text-red-500"
                              title="删除"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {dialog}
    </div>
  );
}
