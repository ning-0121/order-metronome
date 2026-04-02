'use client';

import { useState, useEffect } from 'react';
import { submitOrderAmendment, getOrderAmendments, approveOrderAmendment } from '@/app/actions/order-amendments';

const EDITABLE_FIELDS: { key: string; label: string }[] = [
  { key: 'quantity', label: '数量' },
  { key: 'colors', label: '颜色' },
  { key: 'sizes', label: '尺码' },
  { key: 'etd', label: '交期 (ETD)' },
  { key: 'warehouse_due_date', label: '到仓日期' },
  { key: 'unit_price', label: '单价' },
  { key: 'total_amount', label: '总金额' },
  { key: 'payment_terms', label: '付款条件' },
  { key: 'incoterm', label: '贸易条款' },
  { key: 'packaging_type', label: '包装方式' },
  { key: 'factory_name', label: '工厂' },
  { key: 'notes', label: '备注' },
];

interface Props {
  orderId: string;
  order: any;
  isAdmin: boolean;
}

export function OrderAmendmentPanel({ orderId, order, isAdmin }: Props) {
  const [showForm, setShowForm] = useState(false);
  const [amendments, setAmendments] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedField, setSelectedField] = useState('');
  const [newValue, setNewValue] = useState('');
  const [reason, setReason] = useState('');
  const [changes, setChanges] = useState<Record<string, { from: string; to: string }>>({});

  useEffect(() => { loadAmendments(); }, [orderId]);

  async function loadAmendments() {
    const res = await getOrderAmendments(orderId);
    setAmendments(res.data || []);
  }

  function addChange() {
    if (!selectedField || !newValue) return;
    const field = EDITABLE_FIELDS.find(f => f.key === selectedField);
    if (!field) return;
    const currentValue = order[selectedField] ?? '—';
    setChanges(prev => ({ ...prev, [selectedField]: { from: String(currentValue), to: newValue } }));
    setSelectedField('');
    setNewValue('');
  }

  function removeChange(key: string) {
    setChanges(prev => { const n = { ...prev }; delete n[key]; return n; });
  }

  async function handleSubmit() {
    if (Object.keys(changes).length === 0) { alert('请至少添加一项修改'); return; }
    if (reason.trim().length < 5) { alert('请填写修改原因（至少5个字）'); return; }
    setLoading(true);
    const result = await submitOrderAmendment(orderId, changes, reason);
    if (result.error) alert(result.error);
    else {
      alert('修改申请已提交，等待管理员审批');
      setShowForm(false);
      setChanges({});
      setReason('');
      loadAmendments();
    }
    setLoading(false);
  }

  async function handleApprove(id: string, approved: boolean) {
    const note = approved ? '' : prompt('请填写驳回原因') || '';
    if (!approved && !note) return;
    const result = await approveOrderAmendment(id, approved, note);
    if (result.error) alert(result.error);
    else loadAmendments();
  }

  const pendingCount = amendments.filter(a => a.status === 'pending').length;

  return (
    <div className="mt-4">
      {/* 申请按钮 */}
      {!isAdmin && (
        <button
          onClick={() => setShowForm(!showForm)}
          className="text-sm px-4 py-2 rounded-xl border border-amber-300 text-amber-700 hover:bg-amber-50 font-medium transition-all"
        >
          {showForm ? '取消' : '申请修改订单'}
        </button>
      )}

      {/* 申请表单 */}
      {showForm && (
        <div className="mt-4 p-5 rounded-xl border border-amber-200 bg-amber-50 space-y-4">
          <h3 className="font-semibold text-amber-900">订单修改申请</h3>

          {/* 已添加的修改项 */}
          {Object.keys(changes).length > 0 && (
            <div className="space-y-2">
              {Object.entries(changes).map(([key, val]) => (
                <div key={key} className="flex items-center gap-3 p-2 bg-white rounded-lg border border-amber-200">
                  <span className="text-sm font-medium text-gray-700 w-20">
                    {EDITABLE_FIELDS.find(f => f.key === key)?.label}
                  </span>
                  <span className="text-sm text-red-500 line-through">{val.from}</span>
                  <span className="text-sm">→</span>
                  <span className="text-sm text-green-600 font-medium">{val.to}</span>
                  <button onClick={() => removeChange(key)} className="ml-auto text-xs text-red-400 hover:text-red-600">删除</button>
                </div>
              ))}
            </div>
          )}

          {/* 添加修改项 */}
          <div className="flex gap-2">
            <select
              value={selectedField}
              onChange={e => setSelectedField(e.target.value)}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white"
            >
              <option value="">选择要修改的字段</option>
              {EDITABLE_FIELDS.filter(f => !changes[f.key]).map(f => (
                <option key={f.key} value={f.key}>{f.label}</option>
              ))}
            </select>
            <input
              type="text"
              value={newValue}
              onChange={e => setNewValue(e.target.value)}
              placeholder="修改为..."
              className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
            <button
              onClick={addChange}
              disabled={!selectedField || !newValue}
              className="px-3 py-2 rounded-lg bg-amber-600 text-white text-sm font-medium hover:bg-amber-700 disabled:opacity-50"
            >
              添加
            </button>
          </div>

          {/* 原因 */}
          <div>
            <label className="block text-sm font-medium text-amber-800 mb-1">修改原因 *</label>
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="请说明修改原因（如：客户通知数量变更、交期调整等）"
              rows={3}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>

          <button
            onClick={handleSubmit}
            disabled={loading || Object.keys(changes).length === 0}
            className="px-5 py-2.5 rounded-xl bg-amber-600 text-white font-medium text-sm hover:bg-amber-700 disabled:opacity-50"
          >
            {loading ? '提交中...' : '提交修改申请'}
          </button>
        </div>
      )}

      {/* 修改历史 */}
      {amendments.length > 0 && (
        <div className="mt-4 space-y-3">
          <h3 className="text-sm font-semibold text-gray-700">
            修改申请记录
            {pendingCount > 0 && <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">{pendingCount} 待审批</span>}
          </h3>
          {amendments.map((a: any) => (
            <div key={a.id} className={`p-4 rounded-xl border text-sm ${
              a.status === 'pending' ? 'border-amber-200 bg-amber-50' :
              a.status === 'approved' ? 'border-green-200 bg-green-50' :
              'border-red-200 bg-red-50'
            }`}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                    a.status === 'pending' ? 'bg-amber-200 text-amber-800' :
                    a.status === 'approved' ? 'bg-green-200 text-green-800' :
                    'bg-red-200 text-red-800'
                  }`}>
                    {a.status === 'pending' ? '待审批' : a.status === 'approved' ? '已批准' : '已驳回'}
                  </span>
                  <span className="text-gray-500">{a.requester?.name || a.requester?.email || '—'}</span>
                  <span className="text-gray-400">{new Date(a.created_at).toLocaleDateString('zh-CN')}</span>
                </div>
                {isAdmin && a.status === 'pending' && (
                  <div className="flex gap-2">
                    <button onClick={() => handleApprove(a.id, true)} className="px-3 py-1 rounded-lg bg-green-600 text-white text-xs font-medium hover:bg-green-700">批准</button>
                    <button onClick={() => handleApprove(a.id, false)} className="px-3 py-1 rounded-lg bg-red-600 text-white text-xs font-medium hover:bg-red-700">驳回</button>
                  </div>
                )}
              </div>
              <div className="space-y-1 mb-2">
                {Object.entries(a.fields_to_change || {}).map(([key, val]: [string, any]) => (
                  <div key={key} className="flex items-center gap-2">
                    <span className="text-gray-600 font-medium">{EDITABLE_FIELDS.find(f => f.key === key)?.label || key}：</span>
                    <span className="text-red-500 line-through">{val.from}</span>
                    <span>→</span>
                    <span className="text-green-600 font-medium">{val.to}</span>
                  </div>
                ))}
              </div>
              <p className="text-gray-600">原因：{a.reason}</p>
              {a.admin_note && <p className="text-gray-500 mt-1">管理员备注：{a.admin_note}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
