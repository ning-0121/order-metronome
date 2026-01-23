'use client';

import { useState } from 'react';
import { approveDelayRequest, rejectDelayRequest } from '@/app/actions/delays';
import { useRouter } from 'next/navigation';
import { formatDate } from '@/lib/utils/date';

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
          <h3 className="text-lg font-semibold mb-2 text-gray-900">Pending Requests</h3>
          {pendingRequests.map((request) => (
            <div key={request.id} className="border border-yellow-200 bg-yellow-50 rounded-lg p-4 mb-4">
              <div className="flex justify-between items-start mb-2">
                <div className="flex-1">
                  <p className="font-semibold text-gray-900">Reason Type: <span className="text-gray-700">{request.reason_type}</span></p>
                  <p className="text-sm text-gray-700 mt-1"><strong>Reason Detail:</strong> {request.reason_detail}</p>
                  {request.proposed_new_anchor_date && (
                    <p className="text-sm text-gray-700 mt-1"><strong>Proposed New Anchor Date:</strong> <span className="text-gray-900">{formatDate(request.proposed_new_anchor_date)}</span></p>
                  )}
                  {request.proposed_new_due_at && (
                    <p className="text-sm text-gray-700 mt-1"><strong>Proposed New Due Date:</strong> <span className="text-gray-900">{formatDate(request.proposed_new_due_at)}</span></p>
                  )}
                  {request.requires_customer_approval && (
                    <div className="text-sm mt-2">
                      <strong className="text-orange-700">Requires Customer Approval:</strong> Yes
                      {request.customer_approval_evidence_url ? (
                        <span className="ml-2 text-green-700">✓ Evidence provided</span>
                      ) : (
                        <span className="ml-2 text-red-700">⚠ No evidence</span>
                      )}
                    </div>
                  )}
                  {request.customer_approval_evidence_url && (
                    <div className="text-sm text-gray-600 mt-1">
                      <a
                        href={request.customer_approval_evidence_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:text-blue-700"
                      >
                        View Customer Approval Evidence
                      </a>
                    </div>
                  )}
                  <p className="text-xs text-gray-600 mt-2">Created: {formatDate(request.created_at)}</p>
                </div>
                <div className="flex gap-2 ml-4">
                  {!showDecisionForm[request.id] && isAdmin && (
                    <button
                      onClick={() => setShowDecisionForm((prev) => ({ ...prev, [request.id]: true }))}
                      className="text-sm text-blue-600 hover:text-blue-700 font-medium"
                    >
                      Review
                    </button>
                  )}
                </div>
              </div>
              {showDecisionForm[request.id] && (
                <div className="mt-4 space-y-2 border-t border-yellow-300 pt-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Decision Note
                    </label>
                    <textarea
                      value={decisionNote[request.id] || ''}
                      onChange={(e) => setDecisionNote((prev) => ({ ...prev, [request.id]: e.target.value }))}
                      className="w-full rounded-md border border-gray-300 px-3 py-2 bg-white text-gray-900 placeholder-gray-400"
                      rows={2}
                      placeholder="Optional note..."
                    />
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleApprove(request.id)}
                      disabled={processingId === request.id}
                      className="rounded-md bg-green-600 px-4 py-2 text-white hover:bg-green-700 disabled:opacity-50"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => handleReject(request.id)}
                      disabled={processingId === request.id}
                      className="rounded-md bg-red-600 px-4 py-2 text-white hover:bg-red-700 disabled:opacity-50"
                    >
                      Reject
                    </button>
                    <button
                      onClick={() => {
                        setShowDecisionForm((prev) => ({ ...prev, [request.id]: false }));
                        setDecisionNote((prev) => ({ ...prev, [request.id]: '' }));
                      }}
                      className="rounded-md border border-gray-300 px-4 py-2 text-gray-700 hover:bg-gray-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {processedRequests.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold mb-2 text-gray-900">Processed Requests</h3>
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
                {request.status === 'approved' ? '✓ Approved' : '✗ Rejected'}
              </p>
              <p className="text-sm text-gray-700 mt-1">{request.reason_detail}</p>
              {request.decision_note && (
                <p className="text-sm mt-1 text-gray-700">Note: <span className="text-gray-900">{request.decision_note}</span></p>
              )}
              {request.approved_at && (
                <p className="text-xs text-gray-600 mt-1">
                  {request.status === 'approved' ? 'Approved' : 'Rejected'} at:{' '}
                  {formatDate(request.approved_at)}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {delayRequests.length === 0 && (
        <p className="text-gray-500 bg-gray-50 p-4 rounded">No delay requests</p>
      )}
    </div>
  );
}
