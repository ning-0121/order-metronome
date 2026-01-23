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
      setError('Reason detail is required');
      setLoading(false);
      return;
    }

    if (delayType === 'anchor' && !proposedNewAnchorDate) {
      setError('New anchor date is required');
      setLoading(false);
      return;
    }

    if (delayType === 'milestone' && !proposedNewDueAt) {
      setError('New due date is required');
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
          Reason Type <span className="text-red-500">*</span>
        </label>
        <select
          value={reasonType}
          onChange={(e) => setReasonType(e.target.value as DelayReasonType)}
          className="w-full rounded-md border border-gray-300 px-3 py-2 bg-white text-gray-900"
          required
        >
          <option value="customer_confirmation">Customer Confirmation</option>
          <option value="supplier_delay">Supplier Delay</option>
          <option value="internal_delay">Internal Delay</option>
          <option value="logistics">Logistics</option>
          <option value="force_majeure">Force Majeure</option>
          <option value="other">Other</option>
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Reason Detail <span className="text-red-500">*</span>
        </label>
        <textarea
          value={reasonDetail}
          onChange={(e) => setReasonDetail(e.target.value)}
          className="w-full rounded-md border border-gray-300 px-3 py-2 bg-white text-gray-900 placeholder-gray-400"
          rows={3}
          required
          placeholder="Explain why this delay is needed..."
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Delay Type <span className="text-red-500">*</span>
        </label>
        <select
          value={delayType}
          onChange={(e) => setDelayType(e.target.value as 'anchor' | 'milestone')}
          className="w-full rounded-md border border-gray-300 px-3 py-2 bg-white text-gray-900"
          required
        >
          <option value="anchor">Change Anchor Date ({orderIncoterm === 'FOB' ? 'ETD' : 'Warehouse Due Date'})</option>
          <option value="milestone">Change This Milestone Due Date Only</option>
        </select>
      </div>

      {delayType === 'anchor' && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            New {orderIncoterm === 'FOB' ? 'ETD' : 'Warehouse Due Date'} <span className="text-red-500">*</span>
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
            New Due Date <span className="text-red-500">*</span>
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
                Requires Customer Approval
              </span>
            </label>
          </div>
          {requiresCustomerApproval && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Customer Approval Evidence URL
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
        {loading ? 'Submitting...' : 'Submit Delay Request'}
      </button>
    </form>
  );
}

