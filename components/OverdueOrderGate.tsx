'use client';

/**
 * 超期订单强制确认门禁
 *
 * 当订单交期已过且未全部完成时，打开订单详情页时强制弹窗：
 * 1. 已发货（补录数据）→ 标记完成
 * 2. 未发货，等待发货 → 填写预计发货日
 * 3. 未发货，有问题 → 必须填原因+新计划
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  orderId: string;
  orderNo: string;
  customerName: string;
  keyDate: string;       // 出厂日/ETD
  daysOverdue: number;
  isAdmin: boolean;
}

export function OverdueOrderGate({ orderId, orderNo, customerName, keyDate, daysOverdue, isAdmin }: Props) {
  const router = useRouter();
  const [choice, setChoice] = useState<'' | 'shipped' | 'pending' | 'problem'>('');
  const [newDate, setNewDate] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  async function handleConfirm() {
    if (!choice) return;
    if (choice === 'pending' && !newDate) {
      alert('请填写预计发货日期');
      return;
    }
    if (choice === 'problem' && !reason.trim()) {
      alert('请填写未发货原因');
      return;
    }

    setSubmitting(true);
    try {
      const { createClient } = await import('@/lib/supabase/client');
      const supabase = createClient();
      const now = new Date().toISOString();

      if (choice === 'shipped') {
        // 已发货 → 标记所有节点完成 + 订单完成
        await (supabase.from('milestones') as any)
          .update({ status: 'done', actual_at: now })
          .eq('order_id', orderId)
          .neq('status', 'done');
        await (supabase.from('orders') as any)
          .update({
            lifecycle_status: 'completed',
            notes: `【超期确认】已发货，系统自动标记完成（确认时间：${now}）`,
          })
          .eq('id', orderId);
        router.refresh();
        setDismissed(true);
      } else if (choice === 'pending') {
        // 等待发货 → 更新出厂日期 + 重算排期
        await (supabase.from('orders') as any)
          .update({
            factory_date: newDate,
            notes: `【超期确认】待发货，新预计发货日 ${newDate}`,
          })
          .eq('id', orderId);
        router.refresh();
        setDismissed(true);
      } else if (choice === 'problem') {
        // 有问题 → 记录原因
        await (supabase.from('orders') as any)
          .update({
            special_tags: ['交期逾期'],
            notes: `【超期确认】未发货原因：${reason}${newDate ? `，新预计日期：${newDate}` : ''}`,
          })
          .eq('id', orderId);
        router.refresh();
        setDismissed(true);
      }
    } catch (err: any) {
      alert('操作失败：' + (err?.message || '未知错误'));
    }
    setSubmitting(false);
  }

  return (
    <div className="mb-4 rounded-xl border-2 border-red-300 bg-red-50 p-5">
      <div className="flex items-start gap-3">
        <span className="text-3xl">🚨</span>
        <div className="flex-1">
          <h3 className="text-base font-bold text-red-900">
            订单 {orderNo} 已超出交期 {daysOverdue} 天
          </h3>
          <p className="text-sm text-red-700 mt-1">
            客户 {customerName}，原定 {keyDate}。请确认当前状态：
          </p>

          <div className="mt-3 space-y-2">
            <label className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all ${choice === 'shipped' ? 'border-green-500 bg-green-50' : 'border-gray-200 hover:bg-white'}`}>
              <input type="radio" name="overdue_choice" value="shipped" checked={choice === 'shipped'} onChange={() => setChoice('shipped')} />
              <div>
                <span className="text-sm font-semibold text-green-800">✅ 已发货</span>
                <p className="text-xs text-gray-500">订单已出货，补录系统数据 → 自动标记全部完成</p>
              </div>
            </label>

            <label className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all ${choice === 'pending' ? 'border-amber-500 bg-amber-50' : 'border-gray-200 hover:bg-white'}`}>
              <input type="radio" name="overdue_choice" value="pending" checked={choice === 'pending'} onChange={() => setChoice('pending')} />
              <div>
                <span className="text-sm font-semibold text-amber-800">⏳ 未发货，等待中</span>
                <p className="text-xs text-gray-500">还在生产/等料/等客户确认 → 填写新的预计发货日</p>
              </div>
            </label>

            <label className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all ${choice === 'problem' ? 'border-red-500 bg-red-100' : 'border-gray-200 hover:bg-white'}`}>
              <input type="radio" name="overdue_choice" value="problem" checked={choice === 'problem'} onChange={() => setChoice('problem')} />
              <div>
                <span className="text-sm font-semibold text-red-800">❌ 有问题，无法发货</span>
                <p className="text-xs text-gray-500">品质/面料/客户原因 → 必须填写原因和计划</p>
              </div>
            </label>
          </div>

          {/* 动态表单 */}
          {(choice === 'pending' || choice === 'problem') && (
            <div className="mt-3 space-y-2 pl-6">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  新预计发货日 {choice === 'pending' && <span className="text-red-500">*</span>}
                </label>
                <input type="date" value={newDate} onChange={e => setNewDate(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
              </div>
              {choice === 'problem' && (
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    未发货原因 <span className="text-red-500">*</span>
                  </label>
                  <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2}
                    placeholder="如：面料延迟/品质返工/客户暂停/等客户确认..."
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
                </div>
              )}
            </div>
          )}

          <div className="mt-4 flex gap-2">
            <button onClick={handleConfirm} disabled={!choice || submitting}
              className="px-5 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-50">
              {submitting ? '处理中...' : '确认状态'}
            </button>
            {isAdmin && (
              <button onClick={() => setDismissed(true)}
                className="px-4 py-2 rounded-lg border border-gray-300 text-sm text-gray-600 hover:bg-gray-50">
                暂时跳过
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
