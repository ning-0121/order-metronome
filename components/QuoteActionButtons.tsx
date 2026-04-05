'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  submitQuoteForReview, approveQuote, rejectQuote,
  markQuoteSent, recordCustomerFeedback, createSampleFromQuote,
} from '@/app/actions/quotes';

interface Props {
  quoteId: string;
  orderNo: string;
  stage: string;
  isAdmin: boolean;
  orderPurpose: string;
}

export function QuoteActionButtons({ quoteId, orderNo, stage, isAdmin, orderPurpose }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedbackNote, setFeedbackNote] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [showReject, setShowReject] = useState(false);

  async function execute(fn: () => Promise<{ error?: string; sampleId?: string }>, successMsg?: string) {
    setLoading(true);
    const result = await fn();
    if (result.error) alert(result.error);
    else {
      if ((result as any).sampleId) { router.push(`/orders/${(result as any).sampleId}`); }
      router.refresh();
    }
    setLoading(false);
  }

  return (
    <div className="flex items-center gap-2 flex-wrap shrink-0">
      {/* 草稿/客户要修改 → 提交审批 */}
      {(stage === 'draft' || stage === 'customer_revision') && (
        <button onClick={() => execute(() => submitQuoteForReview(quoteId))} disabled={loading}
          className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 font-medium">
          {loading ? '...' : '提交审批'}
        </button>
      )}

      {/* 待审批 → CEO 审批/驳回 */}
      {stage === 'pending_review' && isAdmin && (
        <>
          <button onClick={() => execute(() => approveQuote(quoteId))} disabled={loading}
            className="text-xs px-3 py-1.5 rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 font-medium">
            ✓ 通过
          </button>
          {showReject ? (
            <div className="flex items-center gap-1">
              <input value={rejectReason} onChange={e => setRejectReason(e.target.value)} placeholder="驳回原因"
                className="text-xs px-2 py-1 rounded border border-gray-300 w-32" />
              <button onClick={() => execute(() => rejectQuote(quoteId, rejectReason))} disabled={loading}
                className="text-xs px-2 py-1 rounded bg-red-600 text-white">驳回</button>
            </div>
          ) : (
            <button onClick={() => setShowReject(true)}
              className="text-xs px-3 py-1.5 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 font-medium">
              ✗ 驳回
            </button>
          )}
        </>
      )}

      {stage === 'pending_review' && !isAdmin && (
        <span className="text-xs text-amber-600">等待CEO审批...</span>
      )}

      {/* 已通过 → 发送客户 */}
      {stage === 'approved' && (
        <button onClick={() => execute(() => markQuoteSent(quoteId))} disabled={loading}
          className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 font-medium">
          📤 已发客户
        </button>
      )}

      {/* 已发客户 → 记录客户反馈 */}
      {stage === 'sent_to_customer' && (
        showFeedback ? (
          <div className="flex items-center gap-1 flex-wrap">
            <input value={feedbackNote} onChange={e => setFeedbackNote(e.target.value)} placeholder="客户反馈备注"
              className="text-xs px-2 py-1 rounded border border-gray-300 w-40" />
            <button onClick={() => execute(() => recordCustomerFeedback(quoteId, 'accepted', feedbackNote))} disabled={loading}
              className="text-xs px-2 py-1 rounded bg-green-600 text-white">接受</button>
            <button onClick={() => execute(() => recordCustomerFeedback(quoteId, 'revision', feedbackNote))} disabled={loading}
              className="text-xs px-2 py-1 rounded bg-amber-600 text-white">要修改</button>
            <button onClick={() => execute(() => recordCustomerFeedback(quoteId, 'rejected', feedbackNote))} disabled={loading}
              className="text-xs px-2 py-1 rounded bg-red-600 text-white">放弃</button>
          </div>
        ) : (
          <button onClick={() => setShowFeedback(true)}
            className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 font-medium">
            📋 记录客户反馈
          </button>
        )
      )}

      {/* 客户接受 → 创建打样单 / 创建订单 */}
      {stage === 'customer_accepted' && orderPurpose === 'inquiry' && (
        <>
          <button onClick={() => { if (confirm(`从 ${orderNo} 创建打样单？`)) execute(() => createSampleFromQuote(quoteId)); }} disabled={loading}
            className="text-xs px-3 py-1.5 rounded-lg bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50 font-medium">
            🧪 创建打样单
          </button>
        </>
      )}

      {/* 客户放弃 */}
      {stage === 'customer_rejected' && (
        <span className="text-xs text-gray-400">已关闭</span>
      )}

      {/* 已创建打样/订单 */}
      {(stage === 'sample_created' || stage === 'order_created') && (
        <span className="text-xs text-green-600">已转入执行</span>
      )}
    </div>
  );
}
