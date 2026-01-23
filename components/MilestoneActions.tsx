'use client';

import { useState, useEffect } from 'react';
import { markMilestoneDone, markMilestoneBlocked } from '@/app/actions/milestones';
import { useRouter } from 'next/navigation';
import type { Milestone } from '@/lib/types';

interface MilestoneActionsProps {
  milestone: Milestone;
  currentRole?: string;
  isAdmin?: boolean;
}

export function MilestoneActions({ milestone, currentRole, isAdmin = false }: MilestoneActionsProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [blockReason, setBlockReason] = useState('');
  const [showBlockForm, setShowBlockForm] = useState(false);
  const [nudging, setNudging] = useState(false);

  // Check if user can modify this milestone
  const canModify = isAdmin || (currentRole && currentRole.toLowerCase() === milestone.owner_role?.toLowerCase());

  async function handleDone() {
    setLoading(true);
    const result = await markMilestoneDone(milestone.id);
    if (!result.error) {
      router.refresh();
    } else {
      alert(result.error);
    }
    setLoading(false);
  }

  async function handleBlock() {
    if (!blockReason || blockReason.trim() === '') {
      alert('Blocked reason is required');
      return;
    }

    setLoading(true);
    const result = await markMilestoneBlocked(milestone.id, blockReason);
    if (!result.error) {
      router.refresh();
      setShowBlockForm(false);
      setBlockReason('');
    } else {
      alert(result.error);
    }
    setLoading(false);
  }

  // 只使用中文状态
  if (milestone.status === '已完成') {
    return <p className="text-green-700 font-semibold bg-green-50 p-2 rounded">✓ 已完成</p>;
  }

  // Only show actions for in_progress milestones
  const isCurrentMilestone = milestone.status === '进行中';

  async function handleNudge() {
    setNudging(true);
    try {
      const response = await fetch('/api/nudge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ milestone_id: milestone.id }),
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        alert(data.error || 'Failed to send nudge');
      } else {
        alert('Nudge sent successfully');
        router.refresh();
      }
    } catch (error: any) {
      alert('Error sending nudge: ' + error.message);
    } finally {
      setNudging(false);
    }
  }

  if (!isCurrentMilestone) {
    return null;
  }

  // Show blocked reason to admin only
  const showBlockedReason = isAdmin && milestone.status === '卡住' && milestone.notes;

  return (
    <div className="space-y-4">
      {/* Blocked reason (admin only) */}
      {showBlockedReason && (
        <div className="rounded-lg border border-orange-200 bg-orange-50 p-3">
          <p className="text-sm font-semibold text-orange-900">Blocked Reason (Admin View):</p>
          <p className="text-sm text-orange-800 mt-1">{milestone.notes}</p>
        </div>
      )}

      {/* Action buttons - only show if user can modify */}
      {canModify && (
        <div className="flex gap-2">
          {milestone.status === '进行中' && (
            <>
              <button
                onClick={handleDone}
                disabled={loading}
                className="rounded-md bg-green-600 px-4 py-2 text-white hover:bg-green-700 disabled:opacity-50"
              >
                ✅ Done
              </button>
              <button
                onClick={() => setShowBlockForm(!showBlockForm)}
                disabled={loading}
                className="rounded-md bg-red-600 px-4 py-2 text-white hover:bg-red-700 disabled:opacity-50"
              >
                ❌ Blocked
              </button>
            </>
          )}
        </div>
      )}

      {/* Nudge button (admin only) */}
      {isAdmin && (milestone.status as string) !== '已完成' && (
        <div className="flex gap-2">
          <button
            onClick={handleNudge}
            disabled={nudging}
            className="rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {nudging ? 'Sending...' : '📧 Nudge Owner'}
          </button>
        </div>
      )}

      {showBlockForm && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Blocked Reason <span className="text-red-500">*</span>
            </label>
            <textarea
              value={blockReason}
              onChange={(e) => setBlockReason(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 bg-white text-gray-900 placeholder-gray-400"
              rows={3}
              placeholder="Explain why this milestone is blocked..."
              required
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleBlock}
              disabled={loading || !blockReason || blockReason.trim() === ''}
              className="rounded-md bg-red-600 px-4 py-2 text-white hover:bg-red-700 disabled:opacity-50"
            >
              Confirm Block
            </button>
            <button
              onClick={() => {
                setShowBlockForm(false);
                setBlockReason('');
              }}
              className="rounded-md border border-gray-300 px-4 py-2 text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
