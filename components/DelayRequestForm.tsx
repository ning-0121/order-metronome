'use client';

import { useState } from 'react';
import { createDelayRequest } from '@/app/actions/delays';
import { useRouter } from 'next/navigation';
import type { Milestone } from '@/lib/types';

interface DelayRequestFormProps {
  milestoneId: string;
  milestone: Milestone;
  orderIncoterm: 'FOB' | 'DDP';
  milestoneDueAt: string | null;
}

type DelayReasonType =
  | 'customer_confirmation'
  | 'supplier_delay'
  | 'internal_delay'
  | 'logistics'
  | 'force_majeure'
  | 'other';

export function DelayRequestForm({ milestoneId, milestone, orderIncoterm, milestoneDueAt }: DelayRequestFormProps) {
  const router = useRouter();
  const [reasonType, setReasonType] = useState<DelayReasonType>('other');
  const [reasonDetail, setReasonDetail] = useState('');
  const [delayType, setDelayType] = useState<'anchor' | 'milestone'>('milestone');
  const [proposedNewAnchorDate, setProposedNewAnchorDate] = useState('');
  const [proposedNewDueAt, setProposedNewDueAt] = useState('');
  const [requiresCustomerApproval, setRequiresCustomerApproval] = useState(false);
  const [customerApprovalEvidenceUrl, setCustomerApprovalEvidenceUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    if (!reasonDetail.trim()) {
      setError('请填写详细原因');
      setLoading(false);
      return;
    }

    if (delayType === 'anchor' && !proposedNewAnchorDate) {
      setError('请选择新的锚点日期');
      setLoading(false);
      return;
    }

    if (delayType === 'milestone' && !proposedNewDueAt) {
      setError('请选择新的到期日期');
      setLoading(false);
      return;
    }

    const result = await createDelayRequest(
      milestoneId,
      reasonType,
      reasonDetail,
      delayType === 'anchor' ? proposedNewAnchorDate : undefined,
      delayType === 'milestone' ? proposedNewDueAt : undefined,
      requiresCustomerApproval,
      customerApprovalEvidenceUrl || undefined
    );

    if (result.error) {
      setError(result.error);
    } else {
      router.refresh();
      // Reset form
      setReasonDetail('');
      setProposedNewAnchorDate('');
      setProposedNewDueAt('');
      setRequiresCustomerApproval(false);
      setCustomerApprovalEvidenceUrl('');
    }
    setLoading(false);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 bg-white">
      {error && (
        <div className="rounded-md bg-red-50 p-2 text-sm text-red-800 border border-red-200">
          {error}
        </div>
      )}

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          原因类型 <span className="text-red-500">*</span>
        </label>
        <select
          value={reasonType}
          onChange={(e) => setReasonType(e.target.value as DelayReasonType)}
          className="w-full rounded-md border border-gray-300 px-3 py-2 bg-white text-gray-900"
          required
        >
          <option value="customer_confirmation">客户确认</option>
          <option value="supplier_delay">供应商延迟</option>
          <option value="internal_delay">内部延迟</option>
          <option value="logistics">物流原因</option>
          <option value="force_majeure">不可抗力</option>
          <option value="other">其他</option>
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          详细原因 <span className="text-red-500">*</span>
        </label>
        <textarea
          value={reasonDetail}
          onChange={(e) => setReasonDetail(e.target.value)}
          className="w-full rounded-md border border-gray-300 px-3 py-2 bg-white text-gray-900 placeholder-gray-400"
          rows={3}
          required
          placeholder="请说明需要延期的原因..."
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          延期类型 <span className="text-red-500">*</span>
        </label>
        <select
          value={delayType}
          onChange={(e) => setDelayType(e.target.value as 'anchor' | 'milestone')}
          className="w-full rounded-md border border-gray-300 px-3 py-2 bg-white text-gray-900"
          required
        >
          <option value="anchor">修改锚点日期（{orderIncoterm === 'FOB' ? 'ETD' : '入仓日'}）</option>
          <option value="milestone">仅修改此节点到期日</option>
        </select>
      </div>

      {delayType === 'anchor' && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            新{orderIncoterm === 'FOB' ? 'ETD' : '入仓日'} <span className="text-red-500">*</span>
          </label>
          <input
            type="date"
            value={proposedNewAnchorDate}
            onChange={(e) => setProposedNewAnchorDate(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 bg-white text-gray-900"
            required
          />
        </div>
      )}

      {delayType === 'milestone' && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            新到期日期 <span className="text-red-500">*</span>
          </label>
          <input
            type="datetime-local"
            value={proposedNewDueAt}
            onChange={(e) => setProposedNewDueAt(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 bg-white text-gray-900"
            required
          />
        </div>
      )}

      {reasonType === 'customer_confirmation' && (
        <>
          <div>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={requiresCustomerApproval}
                onChange={(e) => setRequiresCustomerApproval(e.target.checked)}
                className="rounded"
              />
              <span className="text-sm font-medium text-gray-700">
                需要客户确认
              </span>
            </label>
          </div>
          {requiresCustomerApproval && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                客户确认证据链接
              </label>
              <input
                type="url"
                value={customerApprovalEvidenceUrl}
                onChange={(e) => setCustomerApprovalEvidenceUrl(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 bg-white text-gray-900 placeholder-gray-400"
                placeholder="https://..."
              />
            </div>
          )}
        </>
      )}

      <button
        type="submit"
        disabled={loading}
        className="rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {loading ? '提交中...' : '提交延期申请'}
      </button>
    </form>
  );
}

