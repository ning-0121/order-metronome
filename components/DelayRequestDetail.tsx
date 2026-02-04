'use client';

import { useState, useEffect } from 'react';
import { approveDelayRequest, rejectDelayRequest, getImpactedMilestones } from '@/app/actions/delays';
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
  milestone?: {
    id: string;
    name: string;
    due_at: string;
  };
}

interface ImpactedMilestone {
  id: string;
  name: string;
  step_key: string;
  current_due_at: string;
  new_due_at: string;
  delta_days: number;
}

interface DelayRequestDetailProps {
  delayRequest: DelayRequest;
  isAdmin: boolean;
}

// Map reason types to Chinese
const REASON_TYPE_MAP: Record<string, string> = {
  'customer_confirmation': '客户确认',
  'supplier_delay': '供应商延迟',
  'internal_delay': '内部延迟',
  'logistics': '物流问题',
  'force_majeure': '不可抗力',
  'other': '其他',
};

export function DelayRequestDetail({ delayRequest, isAdmin }: DelayRequestDetailProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [impactedMilestones, setImpactedMilestones] = useState<ImpactedMilestone[]>([]);
  const [loadingImpacted, setLoadingImpacted] = useState(false);
  const [decisionNote, setDecisionNote] = useState('');
  const [showActions, setShowActions] = useState(false);

  useEffect(() => {
    if (delayRequest.status === 'pending' && isAdmin) {
      loadImpactedMilestones();
    }
  }, [delayRequest.id, delayRequest.status, isAdmin]);

  async function loadImpactedMilestones() {
    setLoadingImpacted(true);
    const result = await getImpactedMilestones(delayRequest.id);
    if (result.data) {
      setImpactedMilestones(result.data);
    }
    setLoadingImpacted(false);
  }

  async function handleApprove() {
    setLoading(true);
    const result = await approveDelayRequest(delayRequest.id, decisionNote || undefined);
    if (!result.error) {
      router.refresh();
      setShowActions(false);
      setDecisionNote('');
    } else {
      alert(result.error);
    }
    setLoading(false);
  }

  async function handleReject() {
    if (!decisionNote || decisionNote.trim() === '') {
      alert('拒绝延期必须填写审批意见');
      return;
    }
    setLoading(true);
    const result = await rejectDelayRequest(delayRequest.id, decisionNote);
    if (!result.error) {
      router.refresh();
      setShowActions(false);
      setDecisionNote('');
    } else {
      alert(result.error);
    }
    setLoading(false);
  }

  const reasonTypeLabel = REASON_TYPE_MAP[delayRequest.reason_type] || delayRequest.reason_type;
  
  // Get original due_at from milestone
  const originalDueAt = delayRequest.milestone?.due_at || '';
  
  // Get proposed date (prefer proposed_new_due_at, fallback to proposed_new_anchor_date)
  const proposedDueAt = delayRequest.proposed_new_due_at || delayRequest.proposed_new_anchor_date || '';
  
  // Calculate delta days
  let deltaDays = 0;
  if (originalDueAt && proposedDueAt) {
    const original = new Date(originalDueAt);
    const proposed = new Date(proposedDueAt);
    deltaDays = Math.round((proposed.getTime() - original.getTime()) / (1000 * 60 * 60 * 24));
  }

  if (delayRequest.status !== 'pending') {
    return null; // Only show for pending requests
  }

  return (
    <div className="border border-yellow-200 bg-yellow-50 rounded-lg p-6 mb-4">
      <div className="flex items-start justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900">延期申请详情</h3>
        {isAdmin && !showActions && (
          <button
            onClick={() => setShowActions(true)}
            className="text-sm text-blue-600 hover:text-blue-700 font-medium"
          >
            审批
          </button>
        )}
      </div>

      {/* Reason Section */}
      <div className="bg-white rounded-lg p-4 mb-4">
        <h4 className="font-semibold text-gray-900 mb-3">延期原因</h4>
        <div className="space-y-2">
          <div>
            <span className="text-sm font-medium text-gray-600">原因类型:</span>{' '}
            <span className="text-gray-900">{reasonTypeLabel}</span>
          </div>
          <div>
            <span className="text-sm font-medium text-gray-600">详细说明:</span>
            <div className="mt-1 p-3 bg-gray-50 rounded border border-gray-200 text-gray-900 whitespace-pre-wrap">
              {delayRequest.reason_detail}
            </div>
          </div>
        </div>
      </div>

      {/* Date Comparison Section */}
      <div className="bg-white rounded-lg p-4 mb-4">
        <h4 className="font-semibold text-gray-900 mb-3">日期变更对比</h4>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <div className="text-sm font-medium text-gray-600 mb-1">原定到期日</div>
            <div className="text-gray-900 font-semibold">
              {originalDueAt ? formatDate(originalDueAt, 'yyyy-MM-dd HH:mm') : 'N/A'}
            </div>
          </div>
          <div>
            <div className="text-sm font-medium text-gray-600 mb-1">提议新到期日</div>
            <div className="text-gray-900 font-semibold">
              {proposedDueAt ? formatDate(proposedDueAt, 'yyyy-MM-dd HH:mm') : 'N/A'}
            </div>
          </div>
          <div>
            <div className="text-sm font-medium text-gray-600 mb-1">变更天数</div>
            <div className={`font-semibold ${deltaDays >= 0 ? 'text-red-600' : 'text-green-600'}`}>
              {deltaDays > 0 ? `+${deltaDays} 天` : deltaDays < 0 ? `${deltaDays} 天` : '无变更'}
            </div>
          </div>
        </div>
      </div>

      {/* Impacted Milestones Section */}
      {isAdmin && (
        <div className="bg-white rounded-lg p-4 mb-4">
          <h4 className="font-semibold text-gray-900 mb-3">受影响的后续节点</h4>
          {loadingImpacted ? (
            <p className="text-sm text-gray-600">计算中...</p>
          ) : impactedMilestones.length > 0 ? (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {impactedMilestones.map((m) => (
                <div key={m.id} className="border border-gray-200 rounded p-3 bg-gray-50">
                  <div className="font-medium text-gray-900 mb-1">{m.name}</div>
                  <div className="grid grid-cols-3 gap-2 text-sm">
                    <div>
                      <span className="text-gray-600">原定:</span>{' '}
                      <span className="text-gray-900">{formatDate(m.current_due_at, 'yyyy-MM-dd HH:mm')}</span>
                    </div>
                    <div>
                      <span className="text-gray-600">新日期:</span>{' '}
                      <span className="text-gray-900">{formatDate(m.new_due_at, 'yyyy-MM-dd HH:mm')}</span>
                    </div>
                    <div>
                      <span className="text-gray-600">变更:</span>{' '}
                      <span className={m.delta_days >= 0 ? 'text-red-600' : 'text-green-600'}>
                        {m.delta_days > 0 ? `+${m.delta_days} 天` : `${m.delta_days} 天`}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-600">无后续节点受影响</p>
          )}
        </div>
      )}

      {/* Evidence Section */}
      {delayRequest.requires_customer_approval && (
        <div className="bg-white rounded-lg p-4 mb-4">
          <h4 className="font-semibold text-gray-900 mb-3">客户审批证据</h4>
          {delayRequest.customer_approval_evidence_url ? (
            <div>
              <span className="text-sm text-green-700 mb-2 inline-block">✓ 已提供证据</span>
              <div className="mt-2">
                <a
                  href={delayRequest.customer_approval_evidence_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:text-blue-700 text-sm font-medium"
                >
                  查看证据文件 →
                </a>
              </div>
            </div>
          ) : (
            <div className="text-sm text-red-700 bg-red-50 p-2 rounded border border-red-200">
              ⚠️ 未提供客户审批证据
            </div>
          )}
        </div>
      )}

      {/* Admin Actions */}
      {isAdmin && showActions && (
        <div className="bg-white rounded-lg p-4 border-t border-yellow-300">
          <h4 className="font-semibold text-gray-900 mb-3">审批操作</h4>
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                审批意见 <span className="text-red-500">*</span>
              </label>
              <textarea
                value={decisionNote}
                onChange={(e) => setDecisionNote(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 bg-white text-gray-900 placeholder-gray-400"
                rows={3}
                placeholder="请输入审批意见（拒绝时必须填写）..."
              />
            </div>
            <div className="flex gap-3">
              <button
                onClick={handleApprove}
                disabled={loading}
                className="flex-1 rounded-md bg-green-600 px-4 py-2 text-white hover:bg-green-700 disabled:opacity-50 font-medium"
              >
                {loading ? '处理中...' : '✓ 批准延期'}
              </button>
              <button
                onClick={handleReject}
                disabled={loading || !decisionNote.trim()}
                className="flex-1 rounded-md bg-red-600 px-4 py-2 text-white hover:bg-red-700 disabled:opacity-50 font-medium"
              >
                {loading ? '处理中...' : '✗ 拒绝延期'}
              </button>
              <button
                onClick={() => {
                  setShowActions(false);
                  setDecisionNote('');
                }}
                className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="text-xs text-gray-600 mt-4">
        申请时间: {formatDate(delayRequest.created_at, 'yyyy-MM-dd HH:mm')}
      </div>
    </div>
  );
}
