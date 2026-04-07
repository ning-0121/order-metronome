'use client';

import { useState, useEffect } from 'react';
import {
  submitOrderAmendment,
  getOrderAmendments,
  approveOrderAmendment,
} from '@/app/actions/order-amendments';
import {
  AMENDMENT_RULES,
  checkAmendmentAllowed,
  type AmendmentRule,
} from '@/lib/domain/amendment-policy';

interface Props {
  orderId: string;
  order: any;
  isAdmin: boolean;
  /** 该订单已完成的 step_key 列表（由父组件传入） */
  doneStepKeys?: string[];
}

export function OrderAmendmentPanel({ orderId, order, isAdmin, doneStepKeys = [] }: Props) {
  const [showForm, setShowForm] = useState(false);
  const [amendments, setAmendments] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedField, setSelectedField] = useState('');
  const [newValue, setNewValue] = useState('');
  const [reason, setReason] = useState('');
  const [changes, setChanges] = useState<Record<string, { from: string; to: string }>>({});

  const doneSet = new Set(doneStepKeys);

  useEffect(() => { loadAmendments(); }, [orderId]);

  async function loadAmendments() {
    const res = await getOrderAmendments(orderId);
    setAmendments(res.data || []);
  }

  // 当前选中字段的规则与窗口状态
  const selectedRule = selectedField
    ? AMENDMENT_RULES.find(r => r.field === selectedField) || null
    : null;
  const selectedCheck = selectedField ? checkAmendmentAllowed(selectedField, doneSet) : null;

  function fieldCurrentValue(rule: AmendmentRule): string {
    if (rule.field === 'quantity_increase' || rule.field === 'quantity_decrease') {
      return String(order.quantity ?? '—');
    }
    return String(order[rule.field] ?? '—');
  }

  function addChange() {
    if (!selectedField || !newValue || !selectedRule || !selectedCheck?.allowed) return;
    const currentValue = fieldCurrentValue(selectedRule);
    setChanges(prev => ({
      ...prev,
      [selectedField]: { from: currentValue, to: newValue },
    }));
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
    if (result.error) {
      let msg = result.error;
      if (result.childOrderHint) {
        msg += '\n\n💡 加单超过窗口期：请在订单页发起「创建追加子订单」（暂未上线，可联系管理员）';
      }
      alert(msg);
    } else {
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

  // 把规则分成 可改 / 锁定 两组，便于显示
  const allowedRules = AMENDMENT_RULES.filter(r => checkAmendmentAllowed(r.field, doneSet).allowed);
  const blockedRules = AMENDMENT_RULES.filter(r => !checkAmendmentAllowed(r.field, doneSet).allowed);

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
              {Object.entries(changes).map(([key, val]) => {
                const rule = AMENDMENT_RULES.find(r => r.field === key);
                return (
                  <div key={key} className="flex items-center gap-3 p-2 bg-white rounded-lg border border-amber-200">
                    <span className="text-sm font-medium text-gray-700 w-20">
                      {rule?.label || key}
                    </span>
                    <span className="text-sm text-red-500 line-through">{val.from}</span>
                    <span className="text-sm">→</span>
                    <span className="text-sm text-green-600 font-medium">{val.to}</span>
                    <button onClick={() => removeChange(key)} className="ml-auto text-xs text-red-400 hover:text-red-600">删除</button>
                  </div>
                );
              })}
            </div>
          )}

          {/* 添加修改项 */}
          <div className="flex gap-2">
            <select
              value={selectedField}
              onChange={e => { setSelectedField(e.target.value); setNewValue(''); }}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white min-w-[140px]"
            >
              <option value="">选择字段</option>
              <optgroup label="✅ 可改">
                {allowedRules
                  .filter(r => !changes[r.field])
                  .map(r => (
                    <option key={r.field} value={r.field}>{r.label}</option>
                  ))}
              </optgroup>
              {blockedRules.length > 0 && (
                <optgroup label="🔒 已锁定">
                  {blockedRules.map(r => (
                    <option key={r.field} value={r.field} disabled>
                      {r.label}（已超窗口）
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            {selectedRule?.inputType === 'select' && selectedRule.options ? (
              <select
                value={newValue}
                onChange={e => setNewValue(e.target.value)}
                className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white"
              >
                <option value="">选择新值...</option>
                {selectedRule.options.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            ) : (
              <input
                type={selectedRule?.inputType === 'number' ? 'number' : 'text'}
                value={newValue}
                onChange={e => setNewValue(e.target.value)}
                placeholder="修改为..."
                className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            )}
            <button
              onClick={addChange}
              disabled={!selectedField || !newValue || !selectedCheck?.allowed}
              className="px-3 py-2 rounded-lg bg-amber-600 text-white text-sm font-medium hover:bg-amber-700 disabled:opacity-50"
            >
              添加
            </button>
          </div>

          {/* 当前字段窗口期提示 */}
          {selectedRule && selectedCheck && !selectedCheck.allowed && (
            <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
              🔒 <span className="font-medium">{selectedRule.label}</span> 已锁定：{selectedCheck.reason}
            </div>
          )}
          {selectedRule && selectedCheck?.allowed && selectedRule.postApprovalReminder && (
            <div className="rounded-lg bg-amber-100 border border-amber-300 p-3 text-xs text-amber-800 whitespace-pre-line">
              <span className="font-semibold">⚠️ 审批通过后业务必做：</span>
              {'\n'}{selectedRule.postApprovalReminder}
            </div>
          )}

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
                {Object.entries(a.fields_to_change || {}).map(([key, val]: [string, any]) => {
                  const rule = AMENDMENT_RULES.find(r => r.field === key);
                  return (
                    <div key={key} className="flex items-center gap-2">
                      <span className="text-gray-600 font-medium">{rule?.label || key}：</span>
                      <span className="text-red-500 line-through">{val.from}</span>
                      <span>→</span>
                      <span className="text-green-600 font-medium">{val.to}</span>
                    </div>
                  );
                })}
              </div>
              <p className="text-gray-600">原因：{a.reason}</p>
              {a.admin_note && (
                <p className="text-gray-600 mt-1 whitespace-pre-line">
                  <span className="font-medium">备注：</span>{a.admin_note}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
