'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  orderId: string;
  orderNo: string;
  lifecycleStatus: string;
  isAdmin: boolean;
  isOrderOwner: boolean;
  /** Sprint 1 / A：批准导入按钮仅对财务显示 */
  isFinance?: boolean;
}

export function OrderActions({ orderId, orderNo, lifecycleStatus, isAdmin, isOrderOwner, isFinance = false }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [showCancelForm, setShowCancelForm] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelType, setCancelType] = useState('customer');

  const isDraft = lifecycleStatus === 'draft';
  const canActivate = false; // 自动激活：阶段1全部完成后系统自动确认，不再手动操作
  // 删除规则：
  // - draft 订单 → 创建者或管理员都可以删
  // - 非 draft 订单 → 只有管理员能强制删除（用于清理脏数据）
  const canDelete = isAdmin || (isDraft && isOrderOwner);
  const isForceDelete = isAdmin && !isDraft;
  // 取消逻辑：业务员申请取消→管理员审批，管理员直接取消
  const canRequestCancel = !isDraft && lifecycleStatus !== 'cancelled' && lifecycleStatus !== 'completed' && isOrderOwner && !isAdmin;
  const canDirectCancel = !isDraft && lifecycleStatus !== 'cancelled' && lifecycleStatus !== 'completed' && isAdmin;

  async function handleActivate() {
    if (!confirm(`确认启动订单 ${orderNo}？启动后将进入执行状态。`)) return;
    setLoading(true);
    try {
      const { activateOrderAction } = await import('@/app/actions/orders');
      const result = await activateOrderAction(orderId);
      if (result.error) {
        alert(result.error);
      } else {
        router.refresh();
      }
    } catch {
      alert('启动失败');
    }
    setLoading(false);
  }

  async function handleDelete() {
    const warningPrefix = isForceDelete
      ? `⚠️ 管理员强制删除\n\n该订单状态为「${lifecycleStatus}」，并非草稿。\n` +
        `删除后将同时清理：里程碑、操作日志、延期申请、附件、变更申请、通知。\n` +
        `此操作不可恢复！\n\n`
      : `确定删除订单？此操作不可恢复！\n\n`;
    const input = prompt(warningPrefix + `请输入订单号 ${orderNo} 确认删除：`);
    if (!input || input.trim() !== orderNo) {
      if (input !== null) alert('订单号输入不正确，删除已取消');
      return;
    }
    // 非草稿订单需要二次确认
    if (isForceDelete && !confirm(`再次确认：真的要强制删除「${orderNo}」吗？`)) return;
    setLoading(true);

    try {
      const res = await fetch(`/api/orders/${orderId}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.error) {
        alert(json.error);
      } else {
        router.push('/orders');
        router.refresh();
      }
    } catch {
      alert('删除失败');
    }
    setLoading(false);
  }

  async function handleCancel() {
    if (!cancelReason.trim()) { alert('请填写取消原因'); return; }
    setLoading(true);

    try {
      const { requestCancelAction } = await import('@/app/actions/orders');
      const result = await requestCancelAction(orderId, cancelType, cancelReason.trim());
      if (result.error) {
        alert(result.error);
      } else {
        setShowCancelForm(false);
        setCancelReason('');
        router.refresh();
        alert('取消申请已提交，等待管理员审批');
      }
    } catch {
      alert('提交失败');
    }
    setLoading(false);
  }

  // CEO 可以强制标记完成（跳过节拍校验）
  const canForceComplete = isAdmin && !isDraft && lifecycleStatus !== '已完成' && lifecycleStatus !== 'completed' && lifecycleStatus !== 'cancelled' && lifecycleStatus !== '已取消' && lifecycleStatus !== 'pending_approval';

  // 批准导入：仅财务（Sprint 1 / A）
  // admin 兜底方式：临时给账号加 finance role（profiles.roles），无需改代码
  const canApproveImport = isFinance && lifecycleStatus === 'pending_approval';

  async function handleForceComplete() {
    if (!confirm(`确定将「${orderNo}」强制标记为已完成？\n\n所有未完成的节拍将批量标为完成。此操作用于：\n• 客户取消但部分完成的订单\n• 历史导入订单不需要继续跟的\n• 特殊情况 CEO 直接结案`)) return;
    if (!confirm('再次确认：真的要结案吗？')) return;
    setLoading(true);
    try {
      const { forceCompleteOrderAction } = await import('@/app/actions/orders');
      const res = await forceCompleteOrderAction(orderId);
      if (res.error) alert(res.error);
      else { alert(`✅ ${orderNo} 已标记完成`); router.refresh(); }
    } catch {
      alert('操作失败');
    }
    setLoading(false);
  }

  async function handleApproveImport() {
    if (!confirm(`批准「${orderNo}」作为进行中订单导入？批准后将自动激活里程碑。`)) return;
    setLoading(true);
    try {
      const { approveImportOrder } = await import('@/app/actions/orders');
      const res = await approveImportOrder(orderId);
      if (res.error) alert(res.error);
      else { alert(`✅ ${orderNo} 已批准并激活`); router.refresh(); }
    } catch { alert('操作失败'); }
    setLoading(false);
  }

  async function handleRejectImport() {
    const reason = prompt('拒绝原因（可选）：');
    if (reason === null) return; // 用户点了取消
    setLoading(true);
    try {
      const { rejectImportOrder } = await import('@/app/actions/orders');
      const res = await rejectImportOrder(orderId, reason);
      if (res.error) alert(res.error);
      else { alert(`❌ ${orderNo} 已拒绝`); router.refresh(); }
    } catch { alert('操作失败'); }
    setLoading(false);
  }

  // 重新同步到财务系统：仅 admin / finance 可见
  // SoT 边界：仅推送订单主数据，不涉及收款字段（收款 SoT 在 Finance System）
  const canResyncFinance = (isAdmin || isFinance) && !isDraft && lifecycleStatus !== 'cancelled';

  async function handleResyncFinance() {
    if (!confirm(`将订单「${orderNo}」的主数据重新同步到财务系统？\n\n仅推送订单金额/币种/付款条款等主数据，不涉及收款记录。`)) return;
    setLoading(true);
    try {
      const { resyncOrderToFinance } = await import('@/app/actions/finance-resync');
      const res = await resyncOrderToFinance(orderId);
      if (!res.ok) {
        alert(`同步失败：${res.error}`);
      } else {
        alert('✅ 已重新同步，请到财务系统刷新查看');
      }
    } catch (e) {
      alert(`同步异常：${e instanceof Error ? e.message : '未知错误'}`);
    }
    setLoading(false);
  }

  if (!canActivate && !canDelete && !canRequestCancel && !canDirectCancel && !canForceComplete && !canApproveImport && !canResyncFinance) return null;

  return (
    <div className="flex items-center gap-2">
      {/* 确认启动订单 */}
      {canActivate && (
        <button
          onClick={handleActivate}
          disabled={loading}
          className="text-xs px-3 py-1.5 rounded-lg bg-green-600 text-white hover:bg-green-700 font-medium disabled:opacity-50"
        >
          确认订单
        </button>
      )}

      {/* 删除订单 */}
      {canDelete && (
        <button
          onClick={handleDelete}
          disabled={loading}
          className={`text-xs px-3 py-1.5 rounded-lg border disabled:opacity-50 ${
            isForceDelete
              ? 'border-red-400 bg-red-50 text-red-700 hover:bg-red-100 font-medium'
              : 'border-red-200 text-red-500 hover:bg-red-50'
          }`}
          title={isForceDelete ? '管理员强制删除（已激活订单）' : '删除草稿订单'}
        >
          {isForceDelete ? '强制删除' : '删除订单'}
        </button>
      )}

      {/* 业务员：申请取消 */}
      {canRequestCancel && !showCancelForm && (
        <button
          onClick={() => setShowCancelForm(true)}
          className="text-xs px-3 py-1.5 rounded-lg border border-orange-200 text-orange-600 hover:bg-orange-50"
        >
          申请取消
        </button>
      )}

      {/* CEO 审批进行中导入 */}
      {canApproveImport && (
        <>
          <button
            onClick={handleApproveImport}
            disabled={loading}
            className="text-xs px-4 py-1.5 rounded-lg bg-green-600 text-white hover:bg-green-700 font-medium disabled:opacity-50"
          >
            ✅ 批准导入
          </button>
          <button
            onClick={handleRejectImport}
            disabled={loading}
            className="text-xs px-3 py-1.5 rounded-lg border border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-50"
          >
            ❌ 拒绝
          </button>
        </>
      )}

      {/* CEO：强制标记完成 */}
      {canForceComplete && (
        <button
          onClick={handleForceComplete}
          disabled={loading}
          className="text-xs px-3 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 font-medium disabled:opacity-50"
        >
          ✅ 标记完成
        </button>
      )}

      {/* 重新同步到财务系统（admin / finance） */}
      {canResyncFinance && (
        <button
          onClick={handleResyncFinance}
          disabled={loading}
          className="text-xs px-3 py-1.5 rounded-lg border border-indigo-200 text-indigo-600 hover:bg-indigo-50 disabled:opacity-50"
          title="将订单主数据（金额/币种/付款条款等）重新推送给外部财务系统。不涉及收款记录。"
        >
          重新同步到财务系统
        </button>
      )}

      {/* 管理员/CEO：直接取消 */}
      {canDirectCancel && !showCancelForm && (
        <button
          onClick={() => setShowCancelForm(true)}
          className="text-xs px-3 py-1.5 rounded-lg border border-red-200 text-red-600 hover:bg-red-50"
        >
          取消订单
        </button>
      )}

      {/* 取消表单 */}
      {showCancelForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setShowCancelForm(false)}>
          <div className="absolute inset-0 bg-black/30" />
          <div className="relative bg-white rounded-xl shadow-xl p-6 w-full max-w-md space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-900">申请取消订单</h3>
            <p className="text-sm text-gray-500">订单 {orderNo}</p>

            <div>
              <label className="text-sm font-medium text-gray-700">取消原因类型</label>
              <select
                value={cancelType}
                onChange={e => setCancelType(e.target.value)}
                className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
              >
                <option value="customer">客户原因</option>
                <option value="internal">内部原因</option>
                <option value="quality">品质问题</option>
                <option value="other">其他</option>
              </select>
            </div>

            <div>
              <label className="text-sm font-medium text-gray-700">详细说明</label>
              <textarea
                value={cancelReason}
                onChange={e => setCancelReason(e.target.value)}
                placeholder="请说明取消原因..."
                rows={3}
                className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
              />
            </div>

            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowCancelForm(false)} className="px-4 py-2 text-sm text-gray-500 hover:bg-gray-100 rounded-lg">
                取消
              </button>
              <button
                onClick={handleCancel}
                disabled={loading || !cancelReason.trim()}
                className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
              >
                {loading ? '提交中...' : '确认取消'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
