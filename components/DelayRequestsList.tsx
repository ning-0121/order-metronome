'use client';

import { useState } from 'react';
import { approveDelayRequest, rejectDelayRequest } from '@/app/actions/delays';
import { useRouter } from 'next/navigation';
import { formatDate } from '@/lib/utils/date';
import { DelayRequestDetail } from './DelayRequestDetail';

interface DelayRequest {
  id: string;
  milestone_id: string;
  reason_type: string;
  reason_detail: string;
  proposed_new_anchor_date: string | null;
  proposed_new_due_at: string | null;
  requires_customer_approval?: boolean;
  customer_approval_evidence_url?: string | null;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  approved_at: string | null;
  decision_note: string | null;
  milestone?: {
    id: string;
    name: string;
    due_at: string;
  };
}

interface DelayRequestsListProps {
  delayRequests: DelayRequest[];
  orderId: string;
  isAdmin?: boolean;
  isOrderOwner?: boolean;
}

export function DelayRequestsList({ delayRequests, orderId, isAdmin = false, isOrderOwner = false }: DelayRequestsListProps) {
  const router = useRouter();
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [decisionNote, setDecisionNote] = useState<Record<string, string>>({});
  const [showDecisionForm, setShowDecisionForm] = useState<Record<string, boolean>>({});

  async function handleApprove(requestId: string) {
    setProcessingId(requestId);
    const result = await approveDelayRequest(requestId, decisionNote[requestId] || '');
    if (!result.error) {
      router.refresh();
      setShowDecisionForm((prev) => ({ ...prev, [requestId]: false }));
      setDecisionNote((prev) => ({ ...prev, [requestId]: '' }));
    } else {
      alert(result.error);
    }
    setProcessingId(null);
  }

  async function handleReject(requestId: string) {
    if (!decisionNote[requestId] || decisionNote[requestId].trim() === '') {
      alert('Decision note is required when rejecting');
      return;
    }
    setProcessingId(requestId);
    const result = await rejectDelayRequest(requestId, decisionNote[requestId]);
    if (!result.error) {
      router.refresh();
      setShowDecisionForm((prev) => ({ ...prev, [requestId]: false }));
      setDecisionNote((prev) => ({ ...prev, [requestId]: '' }));
    } else {
      alert(result.error);
    }
    setProcessingId(null);
  }

  const pendingRequests = delayRequests.filter(r => r.status === 'pending');
  const processedRequests = delayRequests.filter(r => r.status !== 'pending');

  return (
    <div className="space-y-4 bg-white">
      {pendingRequests.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold mb-4 text-gray-900">待审批延期申请</h3>
          {pendingRequests.map((request) => (
            <DelayRequestDetail
              key={request.id}
              delayRequest={request}
              isAdmin={isAdmin}
            />
          ))}
        </div>
      )}

      {processedRequests.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold mb-2 text-gray-900">已处理延期申请</h3>
          {processedRequests.map((request) => (
            <div
              key={request.id}
              className={`border rounded-lg p-4 mb-2 ${
                request.status === 'approved'
                  ? 'border-green-200 bg-green-50'
                  : 'border-red-200 bg-red-50'
              }`}
            >
              <p className="font-semibold text-gray-900">
                {request.status === 'approved' ? '✓ 已批准' : '✗ 已拒绝'}
              </p>
              <p className="text-sm text-gray-700 mt-1">{request.reason_detail}</p>
              {request.decision_note && (
                <p className="text-sm mt-1 text-gray-700">审批意见: <span className="text-gray-900">{request.decision_note}</span></p>
              )}
              {request.approved_at && (
                <p className="text-xs text-gray-600 mt-1">
                  {request.status === 'approved' ? '批准' : '拒绝'}时间:{' '}
                  {formatDate(request.approved_at, 'yyyy-MM-dd HH:mm')}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {delayRequests.length === 0 && (
        <p className="text-gray-500 bg-gray-50 p-4 rounded">暂无延期申请</p>
      )}
    </div>
  );
}
