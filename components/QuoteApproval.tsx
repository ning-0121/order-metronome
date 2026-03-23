'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { approveQuote, rejectQuote } from '@/app/actions/quotes';

const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  pending:  { label: '待审批', className: 'bg-yellow-100 text-yellow-700 border-yellow-200' },
  approved: { label: '已通过', className: 'bg-green-100 text-green-700 border-green-200' },
  rejected: { label: '已驳回', className: 'bg-red-100 text-red-700 border-red-200' },
};

interface Props {
  orderId: string;
  quoteStatus: string | null;
  canApprove: boolean;
  approverName?: string;
  approvedAt?: string | null;
}

export function QuoteApproval({ orderId, quoteStatus, canApprove, approverName, approvedAt }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const status = quoteStatus || 'pending';
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.pending;

  async function handleApprove() {
    setLoading(true);
    setError('');
    const result = await approveQuote(orderId);
    if (result.error) setError(result.error);
    else router.refresh();
    setLoading(false);
  }

  async function handleReject() {
    setLoading(true);
    setError('');
    const result = await rejectQuote(orderId);
    if (result.error) setError(result.error);
    else router.refresh();
    setLoading(false);
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-3">
        <span className={`text-xs font-medium px-2.5 py-1 rounded-full border ${cfg.className}`}>
          {cfg.label}
        </span>

        {canApprove && status === 'pending' && (
          <div className="flex gap-1.5">
            <button
              onClick={handleApprove}
              disabled={loading}
              className="text-xs px-3 py-1.5 rounded-lg bg-green-600 hover:bg-green-700 text-white font-medium disabled:opacity-50 transition-colors"
            >
              通过
            </button>
            <button
              onClick={handleReject}
              disabled={loading}
              className="text-xs px-3 py-1.5 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 font-medium disabled:opacity-50 transition-colors"
            >
              驳回
            </button>
          </div>
        )}

        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>

      {/* 审批人 + 审批时间 */}
      {status !== 'pending' && (approverName || approvedAt) && (
        <p className="text-xs text-gray-400">
          {approverName && <span>审批人: {approverName}</span>}
          {approvedAt && (
            <span className="ml-2">
              {new Date(approvedAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </p>
      )}
    </div>
  );
}
