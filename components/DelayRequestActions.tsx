'use client';

import { useState } from 'react';
import { approveDelayRequest, rejectDelayRequest } from '@/app/actions/delays';
import { useRouter } from 'next/navigation';

interface DelayRequestActionsProps {
  delayRequestId: string;
}

export function DelayRequestActions({ delayRequestId }: DelayRequestActionsProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [decisionNote, setDecisionNote] = useState('');

  async function handleApprove() {
    setLoading(true);
    const result = await approveDelayRequest(delayRequestId, decisionNote || undefined);
    if (!result.error) {
      router.refresh();
      setShowForm(false);
      setDecisionNote('');
    } else {
      alert(result.error);
    }
    setLoading(false);
  }

  async function handleReject() {
    if (!decisionNote || decisionNote.trim() === '') {
      alert('Decision note is required when rejecting');
      return;
    }
    setLoading(true);
    const result = await rejectDelayRequest(delayRequestId, decisionNote);
    if (!result.error) {
      router.refresh();
      setShowForm(false);
      setDecisionNote('');
    } else {
      alert(result.error);
    }
    setLoading(false);
  }

  if (!showForm) {
    return (
      <button
        onClick={() => setShowForm(true)}
        className="text-sm text-blue-600 hover:text-blue-700 font-medium"
      >
        Review
      </button>
    );
  }

  return (
    <div className="space-y-2 min-w-[200px]">
      <textarea
        value={decisionNote}
        onChange={(e) => setDecisionNote(e.target.value)}
        className="w-full rounded-md border border-gray-300 px-2 py-1 text-sm bg-white text-gray-900 placeholder-gray-400"
        rows={2}
        placeholder="Decision note (required for reject)..."
      />
      <div className="flex gap-2">
        <button
          onClick={handleApprove}
          disabled={loading}
          className="flex-1 rounded-md bg-green-600 px-3 py-1.5 text-sm text-white hover:bg-green-700 disabled:opacity-50"
        >
          Approve
        </button>
        <button
          onClick={handleReject}
          disabled={loading || !decisionNote.trim()}
          className="flex-1 rounded-md bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700 disabled:opacity-50"
        >
          Reject
        </button>
      </div>
      <button
        onClick={() => {
          setShowForm(false);
          setDecisionNote('');
        }}
        className="w-full text-xs text-gray-600 hover:text-gray-800"
      >
        Cancel
      </button>
    </div>
  );
}
