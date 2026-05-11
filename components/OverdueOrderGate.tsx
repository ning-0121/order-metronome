'use client';

/**
 * 超期订单强制确认门禁
 *
 * 当订单交期已过且未全部完成时，打开订单详情页时强制弹窗：
 * 1. 已发货（补录数据）→ 标记完成
 * 2. 货已完成，等客户发货通知 → 更新出厂日 + 打待运标签
 * 3. 未发货，等待中 → 更新出厂日 + 记录原因
 * 4. 有问题，无法发货 → 必须填原因+新计划
 * 5. 申请延期（需管理员审批）→ 走正式延期申请流程
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  mergeCustomerShipHoldTag,
  textLooksLikeCustomerShipHold,
} from '@/lib/domain/customerShipHold';
import { createOrderLevelDelayRequest } from '@/app/actions/delays';

const DELAY_CATEGORY_OPTIONS = [
  { value: 'customer', label: '👤 客户原因', desc: '客户未确认/改款/改色/延期验货/未付款' },
  { value: 'supplier', label: '🏭 供应商原因', desc: '面料/辅料延迟，供应商交期延误' },
  { value: 'internal', label: '🏢 内部原因', desc: '工厂排期/品质返工/生产问题' },
  { value: 'force_majeure', label: '⚡ 不可抗力', desc: '疫情/自然灾害/港口封锁' },
] as const;

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
  const [choice, setChoice] = useState<'' | 'shipped' | 'waiting_customer' | 'pending' | 'problem' | 'request_delay'>('');
  const [newDate, setNewDate] = useState('');
  const [reason, setReason] = useState('');
  const [delayCategory, setDelayCategory] = useState<'customer' | 'supplier' | 'internal' | 'force_majeure'>('customer');
  const [delayDetail, setDelayDetail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  async function handleConfirm() {
    if (!choice) return;
    if ((choice === 'pending' || choice === 'problem') && !reason.trim()) {
      alert('请填写未发货原因');
      return;
    }
    if ((choice === 'pending' || choice === 'problem' || choice === 'waiting_customer') && !newDate) {
      alert('请填写新预计发货日期');
      return;
    }
    if (choice === 'request_delay') {
      if (!newDate) { alert('请填写新出厂日期'); return; }
      if (!delayDetail.trim()) { alert('请填写延期原因说明'); return; }
    }

    setSubmitting(true);
    try {
      if (choice === 'request_delay') {
        const categoryLabels: Record<string, string> = {
          customer: '客户原因', supplier: '供应商原因', internal: '内部原因', force_majeure: '不可抗力',
        };
        const result = await createOrderLevelDelayRequest(
          orderId,
          delayCategory,
          categoryLabels[delayCategory],
          delayDetail,
          newDate,
        );
        if (result.error) { alert(`提交失败：${result.error}`); setSubmitting(false); return; }
        alert('延期申请已提交，等待管理员审批。审批通过后系统将自动更新排期。');
        router.refresh();
        setDismissed(true);
        return;
      }

      const { createClient } = await import('@/lib/supabase/client');
      const supabase = createClient();
      const now = new Date().toISOString();

      const loadTags = async () => {
        const { data } = await supabase.from('orders').select('special_tags').eq('id', orderId).maybeSingle();
        return Array.isArray(data?.special_tags) ? data.special_tags : [];
      };

      if (choice === 'shipped') {
        // 已发货 → 标记所有节点完成 + 订单完成
        // 2026-04-27 复盘：CHECK 约束已被 drop，DB 主流是英文枚举 (active/completed/cancelled/draft)
        const { error: msErr } = await (supabase.from('milestones') as any)
          .update({ status: 'done', actual_at: now })
          .eq('order_id', orderId)
          .neq('status', 'done');
        if (msErr) {
          alert(`节点状态更新失败：${msErr.message}\n请刷新页面重试。`);
          setSubmitting(false);
          return;
        }
        const { error: ordErr } = await (supabase.from('orders') as any)
          .update({
            lifecycle_status: 'completed', // ✅ 统一英文枚举
            notes: `【超期确认】已发货，系统自动标记完成（确认时间：${now}）`,
          })
          .eq('id', orderId);
        if (ordErr) {
          alert(`订单状态更新失败：${ordErr.message}\n（节点已标记完成，但订单状态未更新，请联系管理员）`);
          setSubmitting(false);
          return;
        }
        router.refresh();
        setDismissed(true);
      } else if (choice === 'waiting_customer') {
        // 等客户发货通知 → 更新出厂日期 + 「待客户指令出运」标签（区分真实延误）
        const prevTags = await loadTags();
        const { error } = await (supabase.from('orders') as any)
          .update({
            factory_date: newDate,
            special_tags: mergeCustomerShipHoldTag(prevTags),
            notes: `【超期确认】货已完成，等客户发货通知\n新预计发货日：${newDate}（客户通知后出运）`,
          })
          .eq('id', orderId);
        if (error) { alert(`更新失败：${error.message}`); setSubmitting(false); return; }
        router.refresh();
        setDismissed(true);
      } else if (choice === 'pending') {
        // 等待发货 → 更新出厂日期 + 记录原因（原因含「等客户通知」类 → 同步打标签）
        const prevTags = await loadTags();
        const payload: Record<string, unknown> = {
          factory_date: newDate,
          notes: `【超期确认】待发货\n原因：${reason}\n新预计发货日：${newDate}`,
        };
        if (textLooksLikeCustomerShipHold(reason)) {
          payload.special_tags = mergeCustomerShipHoldTag(prevTags);
        }
        const { error } = await (supabase.from('orders') as any)
          .update(payload)
          .eq('id', orderId);
        if (error) { alert(`更新失败：${error.message}`); setSubmitting(false); return; }
        router.refresh();
        setDismissed(true);
      } else if (choice === 'problem') {
        // 有问题 → 记录原因 + 更新日期
        const { error } = await (supabase.from('orders') as any)
          .update({
            factory_date: newDate,
            special_tags: ['交期逾期'],
            notes: `【超期确认】有问题无法发货\n原因：${reason}\n新预计发货日：${newDate}`,
          })
          .eq('id', orderId);
        if (error) { alert(`更新失败：${error.message}`); setSubmitting(false); return; }
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

            <label className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all ${choice === 'waiting_customer' ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:bg-white'}`}>
              <input type="radio" name="overdue_choice" value="waiting_customer" checked={choice === 'waiting_customer'} onChange={() => setChoice('waiting_customer')} />
              <div>
                <span className="text-sm font-semibold text-blue-800">📦 货已完成，等客户发货通知</span>
                <p className="text-xs text-gray-500">生产已完成/货已备好，等客户下发运指令 → 填写预计出运日</p>
              </div>
            </label>

            <label className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all ${choice === 'pending' ? 'border-amber-500 bg-amber-50' : 'border-gray-200 hover:bg-white'}`}>
              <input type="radio" name="overdue_choice" value="pending" checked={choice === 'pending'} onChange={() => setChoice('pending')} />
              <div>
                <span className="text-sm font-semibold text-amber-800">⏳ 未发货，等待中</span>
                <p className="text-xs text-gray-500">还在生产/等料/等工厂排期 → 填写新的预计发货日</p>
              </div>
            </label>

            <label className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all ${choice === 'problem' ? 'border-red-500 bg-red-100' : 'border-gray-200 hover:bg-white'}`}>
              <input type="radio" name="overdue_choice" value="problem" checked={choice === 'problem'} onChange={() => setChoice('problem')} />
              <div>
                <span className="text-sm font-semibold text-red-800">❌ 有问题，无法发货</span>
                <p className="text-xs text-gray-500">品质/面料/客户原因 → 必须填写原因和计划</p>
              </div>
            </label>

            <label className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all ${choice === 'request_delay' ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 hover:bg-white'}`}>
              <input type="radio" name="overdue_choice" value="request_delay" checked={choice === 'request_delay'} onChange={() => setChoice('request_delay')} />
              <div>
                <span className="text-sm font-semibold text-indigo-800">📋 申请延期（需管理员审批）</span>
                <p className="text-xs text-gray-500">填写原因 + 新出厂日 → 走正式审批流程，通过后自动更新排期</p>
              </div>
            </label>
          </div>

          {/* 延期申请表单 */}
          {choice === 'request_delay' && (
            <div className="mt-3 space-y-3 pl-6">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">延期原因类型 <span className="text-red-500">*</span></label>
                <div className="grid grid-cols-2 gap-2">
                  {DELAY_CATEGORY_OPTIONS.map(opt => (
                    <label key={opt.value} className={`flex flex-col p-2 rounded-lg border cursor-pointer text-xs transition-all ${delayCategory === opt.value ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 hover:bg-gray-50'}`}>
                      <input type="radio" name="delay_category" value={opt.value} checked={delayCategory === opt.value}
                        onChange={() => setDelayCategory(opt.value as typeof delayCategory)} className="sr-only" />
                      <span className="font-medium">{opt.label}</span>
                      <span className="text-gray-400 mt-0.5">{opt.desc}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">原因详细说明 <span className="text-red-500">*</span></label>
                <textarea value={delayDetail} onChange={e => setDelayDetail(e.target.value)} rows={2}
                  placeholder="请说明延期具体原因，例如：客户要求修改颜色，需重新生产..."
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">新出厂日 <span className="text-red-500">*</span></label>
                <input type="date" value={newDate} onChange={e => setNewDate(e.target.value)}
                  min={new Date(Date.now() + 86400000).toISOString().slice(0, 10)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
              </div>
              <p className="text-xs text-indigo-600 bg-indigo-50 rounded-lg px-3 py-2">
                提交后管理员将收到通知进行审批。审批通过后系统自动更新所有下游节点排期，出厂日将顺延至 {newDate || '—'}。
              </p>
            </div>
          )}

          {/* 动态表单 */}
          {choice === 'waiting_customer' && (
            <div className="mt-3 space-y-2 pl-6">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  预计出运日（客户通知后） <span className="text-red-500">*</span>
                </label>
                <input type="date" value={newDate} onChange={e => setNewDate(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
              </div>
            </div>
          )}
          {(choice === 'pending' || choice === 'problem') && (
            <div className="mt-3 space-y-2 pl-6">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  未发货原因 <span className="text-red-500">*</span>
                </label>
                <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2}
                  placeholder={choice === 'pending'
                    ? '如：面料还在途中/等客户确认色号/工厂排期延后...'
                    : '如：面料品质不合格需退换/客户暂停订单/品质返工...'}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  新预计发货日 <span className="text-red-500">*</span>
                </label>
                <input type="date" value={newDate} onChange={e => setNewDate(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
              </div>
            </div>
          )}

          <div className="mt-4">
            <button onClick={handleConfirm} disabled={!choice || submitting}
              className="px-5 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-50">
              {submitting ? '处理中...' : '确认状态'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
