'use client';

/**
 * 采购进度共享表 — 实时协作 + 补充采购申请流
 *
 * 补充采购流程：
 *   采购/跟单点"+ 补充采购申请" → 填写物料 + 必填原因
 *   → 系统通知业务确认
 *   → 业务看到黄色"待确认"标记，一键确认
 *   → 财务可查看完整审批记录
 */

import { useState, useEffect } from 'react';
import {
  getProcurementItems,
  addProcurementItem,
  submitSupplementRequest,
  approveSupplementRequest,
  updateProcurementItem,
  deleteProcurementItem,
  initDefaultProcurementItems,
  type ProcurementItem,
} from '@/app/actions/procurement-tracking';
import { createClient } from '@/lib/supabase/client';

interface Props {
  orderId: string;
  canEdit: boolean;    // 采购/业务/跟单/管理员
  canApprove: boolean; // 业务/跟单/管理员/财务可确认补充申请
}

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  pending:    { label: '待下单', color: 'bg-gray-100 text-gray-600' },
  ordered:    { label: '已下单', color: 'bg-blue-100 text-blue-700' },
  in_transit: { label: '运输中', color: 'bg-amber-100 text-amber-700' },
  arrived:    { label: '已到货', color: 'bg-green-100 text-green-700' },
  problem:    { label: '有问题', color: 'bg-red-100 text-red-700' },
};

const CATEGORY_MAP: Record<string, { label: string; icon: string }> = {
  fabric:    { label: '面料',     icon: '🧵' },
  trims:     { label: '辅料',     icon: '🏷️' },
  packaging: { label: '包装材料', icon: '📦' },
  other:     { label: '其他',     icon: '📎' },
};

export function ProcurementTrackingTab({ orderId, canEdit, canApprove }: Props) {
  const [items, setItems] = useState<ProcurementItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [sourceFile, setSourceFile] = useState<{ name: string; url: string } | null>(null);

  // 表单模式：'supplement'（补充申请）| null
  const [formMode, setFormMode] = useState<'supplement' | null>(null);
  const [saving, setSaving] = useState(false);
  const [approvingId, setApprovingId] = useState<string | null>(null);

  // 表单字段
  const [newCategory, setNewCategory] = useState('other');
  const [newName, setNewName] = useState('');
  const [newSupplier, setNewSupplier] = useState('');
  const [newQty, setNewQty] = useState('');
  const [newNotes, setNewNotes] = useState('');
  const [newReason, setNewReason] = useState(''); // 补充原因（必填）

  useEffect(() => { loadData(); }, [orderId]);

  async function loadData() {
    setLoading(true);
    const res = await getProcurementItems(orderId);
    const currentItems = res.data || [];
    setItems(currentItems);

    // 查找原始采购单文件
    let fileFound = false;
    try {
      const supabase = createClient();
      const { data: ms } = await (supabase.from('milestones') as any)
        .select('id').eq('order_id', orderId).eq('step_key', 'procurement_order_placed').maybeSingle();

      let match: { file_name: string; file_url: string } | null = null;
      if (ms?.id) {
        const { data: files } = await (supabase.from('order_attachments') as any)
          .select('file_name, file_url').eq('milestone_id', ms.id)
          .order('created_at', { ascending: false }).limit(1);
        match = (files || [])[0] ?? null;
      }
      if (!match) {
        const { data: files2 } = await (supabase.from('order_attachments') as any)
          .select('file_name, file_url').eq('order_id', orderId)
          .in('file_type', ['production_order', 'procurement_order', 'trims_sheet'])
          .order('created_at', { ascending: false }).limit(1);
        match = (files2 || [])[0] ?? null;
      }
      if (match) { setSourceFile({ name: match.file_name, url: match.file_url }); fileFound = true; }
    } catch {}

    // 自动初始化：有采购文件 + 无跟踪条目
    if (fileFound && currentItems.length === 0) {
      try {
        await initDefaultProcurementItems(orderId);
        const res2 = await getProcurementItems(orderId);
        if (res2.data) setItems(res2.data);
      } catch {}
    }
    setLoading(false);
  }

  async function handleInit() {
    setSaving(true);
    await initDefaultProcurementItems(orderId);
    await loadData();
    setSaving(false);
  }

  // 提交补充采购申请
  async function handleSubmitSupplement() {
    if (!newName.trim()) { alert('请填写物料名称'); return; }
    if (!newReason.trim()) { alert('请填写补充原因（财务审计必填）'); return; }
    setSaving(true);
    const res = await submitSupplementRequest(orderId, {
      category: newCategory,
      item_name: newName.trim(),
      quantity: newQty || undefined,
      supplier: newSupplier || undefined,
      notes: newNotes || undefined,
      supplement_reason: newReason.trim(),
    });
    if (res.error) { alert('提交失败: ' + res.error); }
    else {
      setFormMode(null);
      setNewName(''); setNewCategory('other'); setNewSupplier('');
      setNewQty(''); setNewNotes(''); setNewReason('');
      await loadData();
    }
    setSaving(false);
  }

  // 业务确认补充申请
  async function handleApprove(itemId: string) {
    setApprovingId(itemId);
    const res = await approveSupplementRequest(itemId);
    if (res.error) alert('确认失败: ' + res.error);
    else await loadData();
    setApprovingId(null);
  }

  async function handleUpdate(id: string, field: string, value: string | null) {
    const res = await updateProcurementItem(id, { [field]: value || null });
    if (res.error) { alert('保存失败: ' + res.error); return; }
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

  // 待确认补充申请数量（顶部醒目提示用）
  const pendingSupplementCount = items.filter(i => i.is_supplement && !i.approved_at).length;

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

      {/* 待确认补充申请提醒 */}
      {pendingSupplementCount > 0 && canApprove && (
        <div className="flex items-center gap-2 rounded-lg bg-amber-50 border border-amber-300 px-4 py-2">
          <span>⚠️</span>
          <span className="text-sm font-medium text-amber-800">
            有 {pendingSupplementCount} 条补充采购申请待你确认，请查看下方黄色标记行
          </span>
        </div>
      )}

      {/* 概览栏 */}
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
            {items.length > 0 && (
              <button
                onClick={() => { setFormMode(formMode === 'supplement' ? null : 'supplement'); }}
                className="text-xs px-3 py-1.5 rounded-lg bg-amber-500 text-white hover:bg-amber-600 font-medium">
                {formMode === 'supplement' ? '✕ 取消' : '+ 补充采购申请'}
              </button>
            )}
          </div>
        )}
      </div>

      {/* 补充采购申请表单 */}
      {formMode === 'supplement' && canEdit && (
        <div className="rounded-lg border-2 border-amber-300 bg-amber-50 p-4 space-y-3">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-semibold text-amber-800">📋 补充采购申请</span>
            <span className="text-xs text-amber-600">提交后通知业务确认，确认后方可采购</span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-gray-700">类别</label>
              <select value={newCategory} onChange={e => setNewCategory(e.target.value)}
                className="w-full mt-1 px-3 py-1.5 border rounded-lg text-sm bg-white">
                <option value="fabric">🧵 面料</option>
                <option value="trims">🏷️ 辅料</option>
                <option value="packaging">📦 包装材料</option>
                <option value="other">📎 其他</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-gray-700">物料名称 *</label>
              <input value={newName} onChange={e => setNewName(e.target.value)}
                placeholder="如：防潮纸、备用拉链..."
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
                placeholder="如：500张/200个"
                className="w-full mt-1 px-3 py-1.5 border rounded-lg text-sm" />
            </div>
          </div>
          {/* 补充原因：财务审计必填 */}
          <div>
            <label className="text-xs font-medium text-gray-700">
              补充原因 <span className="text-red-500">*</span>
              <span className="text-gray-400 font-normal ml-1">（财务审计必填，说明为何原采购单未包含此项）</span>
            </label>
            <textarea value={newReason} onChange={e => setNewReason(e.target.value)}
              rows={2} placeholder="如：客户临时要求加防潮包装，原采购单未考虑；或工厂反馈需额外备料防生产损耗..."
              className="w-full mt-1 px-3 py-1.5 border rounded-lg text-sm resize-none" />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-700">备注</label>
            <input value={newNotes} onChange={e => setNewNotes(e.target.value)}
              className="w-full mt-1 px-3 py-1.5 border rounded-lg text-sm" />
          </div>
          <div className="flex gap-2">
            <button onClick={handleSubmitSupplement} disabled={saving}
              className="px-4 py-1.5 rounded-lg bg-amber-500 text-white text-sm hover:bg-amber-600 disabled:opacity-50 font-medium">
              {saving ? '提交中...' : '提交申请（通知业务确认）'}
            </button>
            <button onClick={() => setFormMode(null)}
              className="px-4 py-1.5 rounded-lg border text-sm text-gray-600 hover:bg-gray-50">取消</button>
          </div>
        </div>
      )}

      {/* 空状态 */}
      {items.length === 0 && formMode === null && (
        <div className="text-center py-8 text-gray-400 text-sm">
          暂无采购跟踪数据。{canEdit ? '采购单下达后自动生成，或点击"快速创建默认项"手动初始化。' : '采购单下达后自动生成。'}
        </div>
      )}

      {/* 采购表格（按类别分组） */}
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
                    // 补充项状态
                    const isPendingSupplement = item.is_supplement && !item.approved_at;
                    const isApprovedSupplement = item.is_supplement && !!item.approved_at;
                    const rowBg = isPendingSupplement
                      ? 'border-b bg-amber-50/60 hover:bg-amber-50'
                      : 'border-b hover:bg-blue-50/30 transition-colors';

                    return (
                      <tr key={item.id} className={rowBg}>
                        <td className="px-3 py-2">
                          <div className="space-y-0.5">
                            {canEdit ? (
                              <div className="flex items-center gap-1">
                                <input defaultValue={item.item_name}
                                  onBlur={e => { if (e.target.value !== item.item_name) handleUpdate(item.id, 'item_name', e.target.value); }}
                                  className="flex-1 px-1.5 py-0.5 border border-transparent hover:border-gray-300 rounded text-sm font-medium focus:border-indigo-400 focus:outline-none" />
                                <button title="拆分批次"
                                  onClick={async () => {
                                    const batch = prompt('输入批次名（如颜色：黑色、白色）：');
                                    if (!batch?.trim()) return;
                                    await addProcurementItem(orderId, { category: item.category, item_name: `${item.item_name}-${batch.trim()}`, supplier: item.supplier || undefined });
                                    await loadData();
                                  }}
                                  className="text-xs text-indigo-500 hover:text-indigo-700 shrink-0">+批</button>
                              </div>
                            ) : (
                              <span className="font-medium text-gray-900">{item.item_name}</span>
                            )}
                            {/* 补充状态标签 */}
                            {isPendingSupplement && (
                              <div className="flex items-center gap-1 flex-wrap">
                                <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-medium border border-amber-300">
                                  ⏳ 待业务确认
                                </span>
                                {item.supplement_reason && (
                                  <span className="text-xs text-amber-600 italic">原因：{item.supplement_reason}</span>
                                )}
                              </div>
                            )}
                            {isApprovedSupplement && (
                              <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-green-50 text-green-600 border border-green-200">
                                ✓ 补充已确认
                                {item.approved_by_name && <span className="text-green-500">by {item.approved_by_name}</span>}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          {canEdit ? (
                            <input defaultValue={item.supplier || ''}
                              onBlur={e => { if (e.target.value !== (item.supplier || '')) handleUpdate(item.id, 'supplier', e.target.value); }}
                              className="w-full px-1.5 py-0.5 border border-transparent hover:border-gray-300 rounded text-sm focus:border-indigo-400 focus:outline-none" />
                          ) : <span className="text-gray-600">{item.supplier || '—'}</span>}
                        </td>
                        <td className="px-3 py-2">
                          {canEdit ? (
                            <input defaultValue={item.quantity || ''}
                              onBlur={e => { if (e.target.value !== (item.quantity || '')) handleUpdate(item.id, 'quantity', e.target.value); }}
                              className="w-20 px-1.5 py-0.5 border border-transparent hover:border-gray-300 rounded text-sm focus:border-indigo-400 focus:outline-none" />
                          ) : <span className="text-gray-600">{item.quantity || '—'}</span>}
                        </td>
                        <td className="px-3 py-2">
                          {canEdit ? (
                            <input type="date" defaultValue={item.order_date || ''}
                              onBlur={e => { if (e.target.value !== (item.order_date || '')) handleUpdate(item.id, 'order_date', e.target.value); }}
                              className="px-1.5 py-0.5 border border-transparent hover:border-gray-300 rounded text-xs focus:border-indigo-400 focus:outline-none" />
                          ) : <span className="text-gray-600 text-xs">{item.order_date || '—'}</span>}
                        </td>
                        <td className="px-3 py-2">
                          {canEdit ? (
                            <input type="date" defaultValue={item.expected_arrival || ''}
                              onBlur={e => { if (e.target.value !== (item.expected_arrival || '')) handleUpdate(item.id, 'expected_arrival', e.target.value); }}
                              className="px-1.5 py-0.5 border border-transparent hover:border-gray-300 rounded text-xs focus:border-indigo-400 focus:outline-none" />
                          ) : <span className="text-gray-600 text-xs">{item.expected_arrival || '—'}</span>}
                        </td>
                        <td className="px-3 py-2">
                          {canEdit ? (
                            <input type="date" defaultValue={item.actual_arrival || ''}
                              onBlur={e => {
                                if (e.target.value === (item.actual_arrival || '')) return;
                                handleUpdate(item.id, 'actual_arrival', e.target.value);
                                if (e.target.value && item.status !== 'problem') handleUpdate(item.id, 'status', 'arrived');
                              }}
                              className="px-1.5 py-0.5 border border-transparent hover:border-gray-300 rounded text-xs focus:border-indigo-400 focus:outline-none" />
                          ) : <span className="text-gray-600 text-xs">{item.actual_arrival || '—'}</span>}
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
                          ) : <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${st.color}`}>{st.label}</span>}
                        </td>
                        <td className="px-3 py-2">
                          {canEdit ? (
                            <input defaultValue={item.notes || ''} placeholder="备注..."
                              onBlur={e => { if (e.target.value !== (item.notes || '')) handleUpdate(item.id, 'notes', e.target.value); }}
                              className="w-full px-1.5 py-0.5 border border-transparent hover:border-gray-300 rounded text-xs focus:border-indigo-400 focus:outline-none" />
                          ) : <span className="text-gray-500 text-xs">{item.notes || ''}</span>}
                        </td>
                        <td className="px-3 py-2 text-xs text-gray-400">{item.updated_by_name || ''}</td>
                        {canEdit && (
                          <td className="px-3 py-2 text-center space-y-1">
                            {/* 待确认补充申请：业务/跟单/管理员看到确认按钮 */}
                            {isPendingSupplement && canApprove && (
                              <button
                                onClick={() => handleApprove(item.id)}
                                disabled={approvingId === item.id}
                                className="block w-full text-xs px-2 py-1 rounded bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50 font-medium">
                                {approvingId === item.id ? '...' : '✓ 确认'}
                              </button>
                            )}
                            <button onClick={() => handleDelete(item.id)}
                              className="block w-full text-xs text-red-400 hover:text-red-600">删除</button>
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
        💡 所有人可查看。采购/业务/跟单直接编辑进度，实时保存。
        原始采购单以外的新增物料请点「+ 补充采购申请」→ 填写原因 → 等业务确认后执行。
      </p>
    </div>
  );
}
