'use client';

import { useState, useEffect } from 'react';
import {
  getProcurementItems,
  addProcurementItem,
  recordReceipt,
  deleteProcurementItem,
  exportReconciliationSheet,
  type ProcurementLineItem,
} from '@/app/actions/procurement';

interface Props {
  orderId: string;
  isAdmin: boolean;
  canEdit: boolean; // merchandiser/procurement/sales/admin
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

export function ProcurementTab({ orderId, isAdmin, canEdit }: Props) {
  const [items, setItems] = useState<ProcurementLineItem[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingReceiptId, setEditingReceiptId] = useState<string | null>(null);
  const [receiptQty, setReceiptQty] = useState('');
  const [receiptNotes, setReceiptNotes] = useState('');
  const [exporting, setExporting] = useState(false);

  // 新增表单
  const [formName, setFormName] = useState('');
  const [formSpec, setFormSpec] = useState('');
  const [formSupplier, setFormSupplier] = useState('');
  const [formCategory, setFormCategory] = useState('fabric');
  const [formQty, setFormQty] = useState('');
  const [formUnit, setFormUnit] = useState('KG');
  const [formPrice, setFormPrice] = useState('');
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
    });
    if (res.error) alert(res.error);
    else {
      setFormName(''); setFormSpec(''); setFormQty(''); setFormPrice('');
      setShowAddForm(false);
      load();
    }
    setSubmitting(false);
  }

  async function handleRecordReceipt(itemId: string) {
    if (!receiptQty) return;
    const res = await recordReceipt(itemId, orderId, Number(receiptQty), receiptNotes || undefined);
    if (res.error) alert(res.error);
    else {
      setEditingReceiptId(null);
      setReceiptQty('');
      setReceiptNotes('');
      load();
    }
  }

  async function handleDelete(itemId: string) {
    if (!confirm('删除这条采购明细？')) return;
    await deleteProcurementItem(itemId, orderId);
    load();
  }

  async function handleExport() {
    setExporting(true);
    const res = await exportReconciliationSheet(orderId);
    if (res.error) { alert(res.error); setExporting(false); return; }
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
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div className="bg-white rounded-lg border border-gray-200 p-3 text-center">
            <div className="text-lg font-bold text-gray-800">{summary.itemCount}</div>
            <div className="text-xs text-gray-500">采购项</div>
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
      <div className="flex items-center gap-2">
        {canEdit && (
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 font-medium"
          >
            + 添加采购明细
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
          <div className="grid grid-cols-3 gap-2">
            <input type="number" step="0.01" value={formQty} onChange={e => setFormQty(e.target.value)} placeholder="订购数量 *" required className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            <select value={formUnit} onChange={e => setFormUnit(e.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white">
              <option value="KG">KG</option><option value="M">米</option><option value="PCS">件/个</option><option value="ROLL">卷</option><option value="SET">套</option>
            </select>
            <input type="number" step="0.001" value={formPrice} onChange={e => setFormPrice(e.target.value)} placeholder="单价 ¥" className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
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
                  <th className="px-3 py-2 font-medium text-indigo-600 text-right">订购数量</th>
                  <th className="px-3 py-2 font-medium text-gray-600 text-center">单位</th>
                  <th className="px-3 py-2 font-medium text-gray-600 text-right">单价</th>
                  <th className="px-3 py-2 font-medium text-indigo-600 text-right">订购金额</th>
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
                  return (
                    <tr key={item.id} className={hasDiscrepancy ? 'bg-red-50' : ''}>
                      <td className="px-3 py-2 font-medium text-gray-900">{item.material_name}</td>
                      <td className="px-3 py-2 text-gray-500">{item.specification || '-'}</td>
                      <td className="px-3 py-2 text-gray-500">{item.supplier_name || '-'}</td>
                      <td className="px-3 py-2 text-center">
                        <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
                          {CATEGORY_LABELS[item.category] || item.category}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-indigo-700">{item.ordered_qty}</td>
                      <td className="px-3 py-2 text-center text-gray-500">{item.ordered_unit}</td>
                      <td className="px-3 py-2 text-right font-mono">{item.unit_price ?? '-'}</td>
                      <td className="px-3 py-2 text-right font-mono text-indigo-700">{item.ordered_amount?.toFixed(2) ?? '-'}</td>
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
                              canEdit ? (
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
                          {canEdit && item.received_qty === null && !isEditingReceipt && (
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
                              onClick={() => handleDelete(item.id)}
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
    </div>
  );
}
