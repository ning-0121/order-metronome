'use client';

/**
 * 采购进度共享表 — 实时协作
 * 所有人可看，采购/业务/跟单/管理员可编辑
 */

import { useState, useEffect } from 'react';
import {
  getProcurementItems,
  addProcurementItem,
  updateProcurementItem,
  deleteProcurementItem,
  initDefaultProcurementItems,
  type ProcurementItem,
} from '@/app/actions/procurement-tracking';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

interface Props {
  orderId: string;
  canEdit: boolean; // 采购/业务/跟单/管理员
}

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  pending: { label: '待下单', color: 'bg-gray-100 text-gray-600' },
  ordered: { label: '已下单', color: 'bg-blue-100 text-blue-700' },
  in_transit: { label: '运输中', color: 'bg-amber-100 text-amber-700' },
  arrived: { label: '已到货', color: 'bg-green-100 text-green-700' },
  problem: { label: '有问题', color: 'bg-red-100 text-red-700' },
};

const CATEGORY_MAP: Record<string, { label: string; icon: string }> = {
  fabric: { label: '面料', icon: '🧵' },
  trims: { label: '辅料', icon: '🏷️' },
  packaging: { label: '包装', icon: '📦' },
  other: { label: '其他', icon: '📎' },
};

export function ProcurementTrackingTab({ orderId, canEdit }: Props) {
  const router = useRouter();
  const [items, setItems] = useState<ProcurementItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [sourceFile, setSourceFile] = useState<{ name: string; url: string } | null>(null);

  // 新增表单
  const [newCategory, setNewCategory] = useState('fabric');
  const [newName, setNewName] = useState('');
  const [newSupplier, setNewSupplier] = useState('');
  const [newQty, setNewQty] = useState('');
  const [newNotes, setNewNotes] = useState('');

  useEffect(() => { loadData(); }, [orderId]);

  async function loadData() {
    setLoading(true);
    const res = await getProcurementItems(orderId);
    if (res.data) setItems(res.data);
    // 查找原始采购单文件 — 必须是 procurement_order_placed 节点下的附件
    try {
      const supabase = createClient();
      // 1. 先找到 procurement_order_placed 节点
      const { data: ms } = await (supabase.from('milestones') as any)
        .select('id')
        .eq('order_id', orderId)
        .eq('step_key', 'procurement_order_placed')
        .maybeSingle();
      if (ms?.id) {
        // 2. 按 milestone_id 取该节点下最新附件
        const { data: files } = await (supabase.from('order_attachments') as any)
          .select('file_name, file_url, storage_path')
          .eq('milestone_id', ms.id)
          .order('created_at', { ascending: false })
          .limit(1);
        const match = (files || [])[0];
        if (match) setSourceFile({ name: match.file_name, url: match.file_url });
      }
    } catch {}
    setLoading(false);
  }

  async function handleInit() {
    setSaving(true);
    await initDefaultProcurementItems(orderId);
    await loadData();
    setSaving(false);
  }

  async function handleAdd() {
    if (!newName.trim()) { alert('请填写物料名称'); return; }
    setSaving(true);
    const res = await addProcurementItem(orderId, {
      category: newCategory,
      item_name: newName.trim(),
      supplier: newSupplier || undefined,
      quantity: newQty || undefined,
      notes: newNotes || undefined,
    });
    if (res.error) alert(res.error);
    else {
      setShowAddForm(false);
      setNewName(''); setNewSupplier(''); setNewQty(''); setNewNotes('');
      await loadData();
    }
    setSaving(false);
  }

  async function handleUpdate(id: string, field: string, value: string | null) {
    const res = await updateProcurementItem(id, { [field]: value || null });
    if (res.error) {
      alert('保存失败: ' + res.error);
      return;
    }
    setItems(prev => prev.map(item =>
      item.id === id ? { ...item, [field]: value, updated_at: new Date().toISOString() } : item
    ));
  }

  async function handleDelete(id: string) {
    if (!confirm('确定删除此采购项？')) return;
    const res = await deleteProcurementItem(id);
    if (res.error) { alert('删除失败: ' + res.error); return; }
    setItems(prev => prev.filter(item => item.id !== id));
  }

  if (loading) return <div className="text-center py-8 text-gray-400 text-sm">加载中...</div>;

  // 按类别分组
  const grouped: Record<string, ProcurementItem[]> = {};
  for (const item of items) {
    const cat = item.category || 'other';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(item);
  }

  const arrivedCount = items.filter(i => i.status === 'arrived').length;
  const problemCount = items.filter(i => i.status === 'problem').length;

  return (
    <div className="space-y-4">
      {/* 原始采购单文件 */}
      {sourceFile && (
        <div className="flex items-center gap-3 rounded-lg bg-blue-50 border border-blue-200 px-4 py-2">
          <span className="text-sm">📄</span>
          <div className="flex-1 min-w-0">
            <span className="text-xs text-blue-800 font-medium">原始采购单：</span>
            <span className="text-xs text-blue-600 truncate">{sourceFile.name}</span>
          </div>
          <a href={sourceFile.url} target="_blank" rel="noopener noreferrer"
            className="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 shrink-0">
            查看原件
          </a>
        </div>
      )}

      {/* 概览 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-gray-900">
            📦 采购进度 {items.length > 0 && `${arrivedCount}/${items.length} 已到货`}
          </span>
          {problemCount > 0 && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">
              {problemCount} 个有问题
            </span>
          )}
        </div>
        {canEdit && (
          <div className="flex gap-2">
            {items.length === 0 && (
              <button onClick={handleInit} disabled={saving}
                className="text-xs px-3 py-1.5 rounded-lg bg-indigo-100 text-indigo-700 hover:bg-indigo-200 font-medium disabled:opacity-50">
                {saving ? '初始化...' : '快速创建默认项'}
              </button>
            )}
            <button onClick={() => setShowAddForm(!showAddForm)}
              className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 font-medium">
              + 添加物料
            </button>
          </div>
        )}
      </div>

      {/* 添加表单 */}
      {showAddForm && canEdit && (
        <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-gray-700">类别</label>
              <select value={newCategory} onChange={e => setNewCategory(e.target.value)}
                className="w-full mt-1 px-3 py-1.5 border rounded-lg text-sm">
                <option value="fabric">🧵 面料</option>
                <option value="trims">🏷️ 辅料</option>
                <option value="packaging">📦 包装材料</option>
                <option value="other">📎 其他</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-gray-700">物料名称 *</label>
              <input value={newName} onChange={e => setNewName(e.target.value)}
                placeholder="如：大货面料/拉链/吊牌..."
                className="w-full mt-1 px-3 py-1.5 border rounded-lg text-sm" />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-700">供应商</label>
              <input value={newSupplier} onChange={e => setNewSupplier(e.target.value)}
                className="w-full mt-1 px-3 py-1.5 border rounded-lg text-sm" />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-700">数量</label>
              <input value={newQty} onChange={e => setNewQty(e.target.value)}
                placeholder="如：500米/2000个"
                className="w-full mt-1 px-3 py-1.5 border rounded-lg text-sm" />
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-gray-700">备注</label>
            <input value={newNotes} onChange={e => setNewNotes(e.target.value)}
              className="w-full mt-1 px-3 py-1.5 border rounded-lg text-sm" />
          </div>
          <div className="flex gap-2">
            <button onClick={handleAdd} disabled={saving}
              className="px-4 py-1.5 rounded-lg bg-indigo-600 text-white text-sm hover:bg-indigo-700 disabled:opacity-50">
              {saving ? '添加中...' : '添加'}
            </button>
            <button onClick={() => setShowAddForm(false)}
              className="px-4 py-1.5 rounded-lg border text-sm text-gray-600 hover:bg-gray-50">取消</button>
          </div>
        </div>
      )}

      {/* 空状态 */}
      {items.length === 0 && !showAddForm && (
        <div className="text-center py-8 text-gray-400 text-sm">
          暂无采购跟踪数据。{canEdit ? '采购单下达后自动生成，或点击"添加物料"手动创建。' : '采购单下达后自动生成。'}
        </div>
      )}

      {/* 采购表格 */}
      {Object.entries(grouped).map(([cat, catItems]) => {
        const catInfo = CATEGORY_MAP[cat] || CATEGORY_MAP.other;
        return (
          <div key={cat} className="rounded-lg border border-gray-200 overflow-hidden">
            <div className="bg-gray-50 px-4 py-2 flex items-center gap-2 border-b">
              <span>{catInfo.icon}</span>
              <span className="text-sm font-semibold text-gray-800">{catInfo.label}</span>
              <span className="text-xs text-gray-400">{catItems.length} 项</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-gray-500 border-b bg-gray-50/50">
                    <th className="px-3 py-2 text-left font-medium">物料</th>
                    <th className="px-3 py-2 text-left font-medium">供应商</th>
                    <th className="px-3 py-2 text-left font-medium">数量</th>
                    <th className="px-3 py-2 text-left font-medium">下单日期</th>
                    <th className="px-3 py-2 text-left font-medium">预计到货</th>
                    <th className="px-3 py-2 text-left font-medium">实际到货</th>
                    <th className="px-3 py-2 text-left font-medium">状态</th>
                    <th className="px-3 py-2 text-left font-medium">备注</th>
                    <th className="px-3 py-2 text-left font-medium">更新人</th>
                    {canEdit && <th className="px-3 py-2 text-center font-medium w-16">操作</th>}
                  </tr>
                </thead>
                <tbody>
                  {catItems.map(item => {
                    const st = STATUS_MAP[item.status] || STATUS_MAP.pending;
                    return (
                      <tr key={item.id} className="border-b hover:bg-blue-50/30 transition-colors">
                        <td className="px-3 py-2">
                          {canEdit ? (
                            <div className="flex items-center gap-1">
                              <input defaultValue={item.item_name}
                                onBlur={e => { if (e.target.value !== item.item_name) handleUpdate(item.id, 'item_name', e.target.value); }}
                                className="flex-1 px-1.5 py-0.5 border border-transparent hover:border-gray-300 rounded text-sm font-medium focus:border-indigo-400 focus:outline-none" />
                              <button title="分批到货（拆分为多行分别跟踪）"
                                onClick={async () => {
                                  const batch = prompt('输入批次名（如颜色：黑色、白色，或辅料名：吊牌、烫标）：');
                                  if (!batch?.trim()) return;
                                  await addProcurementItem(orderId, {
                                    category: item.category,
                                    item_name: `${item.item_name}-${batch.trim()}`,
                                    supplier: item.supplier || undefined,
                                  });
                                  await loadData();
                                }}
                                className="text-xs text-indigo-500 hover:text-indigo-700 shrink-0 whitespace-nowrap" >+分批</button>
                            </div>
                          ) : (
                            <span className="font-medium text-gray-900">{item.item_name}</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {canEdit ? (
                            <input defaultValue={item.supplier || ''}
                              onBlur={e => { if (e.target.value !== (item.supplier || '')) handleUpdate(item.id, 'supplier', e.target.value); }}
                              className="w-full px-1.5 py-0.5 border border-transparent hover:border-gray-300 rounded text-sm focus:border-indigo-400 focus:outline-none" />
                          ) : (
                            <span className="text-gray-600">{item.supplier || '—'}</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {canEdit ? (
                            <input defaultValue={item.quantity || ''}
                              onBlur={e => { if (e.target.value !== (item.quantity || '')) handleUpdate(item.id, 'quantity', e.target.value); }}
                              className="w-20 px-1.5 py-0.5 border border-transparent hover:border-gray-300 rounded text-sm focus:border-indigo-400 focus:outline-none" />
                          ) : (
                            <span className="text-gray-600">{item.quantity || '—'}</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {canEdit ? (
                            <input type="date" defaultValue={item.order_date || ''}
                              onBlur={e => { if (e.target.value !== (item.order_date || '')) handleUpdate(item.id, 'order_date', e.target.value); }}
                              className="px-1.5 py-0.5 border border-transparent hover:border-gray-300 rounded text-xs focus:border-indigo-400 focus:outline-none" />
                          ) : (
                            <span className="text-gray-600 text-xs">{item.order_date || '—'}</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {canEdit ? (
                            <input type="date" defaultValue={item.expected_arrival || ''}
                              onBlur={e => { if (e.target.value !== (item.expected_arrival || '')) handleUpdate(item.id, 'expected_arrival', e.target.value); }}
                              className="px-1.5 py-0.5 border border-transparent hover:border-gray-300 rounded text-xs focus:border-indigo-400 focus:outline-none" />
                          ) : (
                            <span className="text-gray-600 text-xs">{item.expected_arrival || '—'}</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {canEdit ? (
                            <input type="date" defaultValue={item.actual_arrival || ''}
                              onBlur={e => {
                                if (e.target.value === (item.actual_arrival || '')) return; // 没变不更新
                                handleUpdate(item.id, 'actual_arrival', e.target.value);
                                if (e.target.value && item.status !== 'problem') handleUpdate(item.id, 'status', 'arrived');
                              }}
                              className="px-1.5 py-0.5 border border-transparent hover:border-gray-300 rounded text-xs focus:border-indigo-400 focus:outline-none" />
                          ) : (
                            <span className="text-gray-600 text-xs">{item.actual_arrival || '—'}</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {canEdit ? (
                            <select defaultValue={item.status}
                              onChange={e => handleUpdate(item.id, 'status', e.target.value)}
                              className={`text-xs px-2 py-1 rounded-full font-medium ${st.color} border-0 cursor-pointer`}>
                              {Object.entries(STATUS_MAP).map(([k, v]) => (
                                <option key={k} value={k}>{v.label}</option>
                              ))}
                            </select>
                          ) : (
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${st.color}`}>{st.label}</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {canEdit ? (
                            <input defaultValue={item.notes || ''} placeholder="备注..."
                              onBlur={e => { if (e.target.value !== (item.notes || '')) handleUpdate(item.id, 'notes', e.target.value); }}
                              className="w-full px-1.5 py-0.5 border border-transparent hover:border-gray-300 rounded text-xs focus:border-indigo-400 focus:outline-none" />
                          ) : (
                            <span className="text-gray-500 text-xs">{item.notes || ''}</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs text-gray-400">{item.updated_by_name || ''}</td>
                        {canEdit && (
                          <td className="px-3 py-2 text-center">
                            <button onClick={() => handleDelete(item.id)}
                              className="text-xs text-red-400 hover:text-red-600">删除</button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      <p className="text-xs text-gray-400 text-center">
        💡 所有人可查看。采购/业务/跟单直接编辑，修改实时保存。分批到货请点「+批」拆分（如面料按颜色拆、辅料按品种拆）。
      </p>
    </div>
  );
}
