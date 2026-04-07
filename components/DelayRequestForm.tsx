'use client';

import { useState, useEffect } from 'react';
import { createDelayRequest } from '@/app/actions/delays';
import { useRouter } from 'next/navigation';
import type { Milestone } from '@/lib/types';
import { DELAY_CATEGORIES, NODE_MAX_DELAY_DAYS, validateDelayRequest, type DelayCategory } from '@/lib/domain/delay-rules';

interface DelayRequestFormProps {
  milestoneId: string;
  milestone: Milestone;
  orderIncoterm: 'FOB' | 'DDP';
  milestoneDueAt: string | null;
}

export function DelayRequestForm({ milestoneId, milestone, orderIncoterm, milestoneDueAt }: DelayRequestFormProps) {
  const router = useRouter();
  const [category, setCategory] = useState<DelayCategory>('customer');
  const [reasonDetail, setReasonDetail] = useState('');
  const [proposedNewDueAt, setProposedNewDueAt] = useState('');
  const [customerEvidenceUrl, setCustomerEvidenceUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationResult, setValidationResult] = useState<any>(null);

  const stepKey = (milestone as any).step_key || '';
  const maxDays = NODE_MAX_DELAY_DAYS[stepKey];
  const categoryInfo = DELAY_CATEGORIES[category];

  // 实时校验
  useEffect(() => {
    if (!proposedNewDueAt || !milestoneDueAt) {
      setValidationResult(null);
      return;
    }
    const result = validateDelayRequest({
      stepKey,
      category,
      currentDueAt: milestoneDueAt,
      proposedDueAt: proposedNewDueAt,
    });
    setValidationResult(result);
  }, [category, proposedNewDueAt, milestoneDueAt, stepKey]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    if (!reasonDetail.trim()) {
      setError('请填写详细原因');
      setLoading(false);
      return;
    }
    if (!proposedNewDueAt) {
      setError('请选择新的到期日期');
      setLoading(false);
      return;
    }
    if (validationResult && !validationResult.allowed) {
      setError(validationResult.reason);
      setLoading(false);
      return;
    }
    if (category === 'force_majeure' && !customerEvidenceUrl) {
      setError('不可抗力原因必须提供客户书面确认证据');
      setLoading(false);
      return;
    }

    // 根据分类决定是否要修改 anchor（客户/不可抗力 → 改 anchor，内部/供应商 → 只改节点）
    const shouldUpdateAnchor = categoryInfo.impactsFinalDeliveryDate;

    const result = await createDelayRequest(
      milestoneId,
      category, // 使用 category 作为 reasonType
      reasonDetail,
      shouldUpdateAnchor ? proposedNewDueAt.slice(0, 10) : undefined, // anchor date
      !shouldUpdateAnchor ? proposedNewDueAt : undefined,                // milestone due
      category === 'force_majeure',
      customerEvidenceUrl || undefined,
      category,
    );

    if (result.error) {
      setError(result.error);
    } else {
      router.refresh();
      setReasonDetail('');
      setProposedNewDueAt('');
      setCustomerEvidenceUrl('');
    }
    setLoading(false);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 bg-white">
      {error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-800 border border-red-200 whitespace-pre-wrap">
          {error}
        </div>
      )}

      {/* 延期原因分类选择 */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          延期原因分类 <span className="text-red-500">*</span>
        </label>
        <div className="grid grid-cols-2 gap-2">
          {(Object.keys(DELAY_CATEGORIES) as DelayCategory[]).map(cat => {
            const info = DELAY_CATEGORIES[cat];
            const isSelected = category === cat;
            const colorMap: Record<string, string> = {
              blue: isSelected ? 'border-blue-500 bg-blue-50' : 'border-gray-200',
              amber: isSelected ? 'border-amber-500 bg-amber-50' : 'border-gray-200',
              red: isSelected ? 'border-red-500 bg-red-50' : 'border-gray-200',
              purple: isSelected ? 'border-purple-500 bg-purple-50' : 'border-gray-200',
            };
            return (
              <button
                key={cat}
                type="button"
                onClick={() => setCategory(cat)}
                className={`text-left p-3 rounded-lg border-2 transition-all ${colorMap[info.color]}`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xl">{info.emoji}</span>
                  <span className="font-semibold text-sm text-gray-900">{info.label}</span>
                </div>
                <div className="text-xs text-gray-500 mt-1 leading-snug">{info.description}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* 分类影响提示 */}
      <div className={`rounded-lg p-3 text-xs ${
        categoryInfo.impactsFinalDeliveryDate
          ? 'bg-blue-50 border border-blue-200 text-blue-800'
          : 'bg-amber-50 border border-amber-200 text-amber-800'
      }`}>
        {categoryInfo.impactsFinalDeliveryDate ? (
          <>📅 <strong>将顺延最终交期</strong>：所有下游节点和 {orderIncoterm === 'FOB' ? 'ETD' : '入仓日'} 同步后移</>
        ) : (
          <>⚠️ <strong>不能影响最终交期</strong>：下游节点保持原日期，窗口被压缩，需加快进度
            {maxDays !== undefined && maxDays > 0 && (
              <div className="mt-1">该节点最多允许延期 <strong>{maxDays} 天</strong></div>
            )}
            {maxDays === 0 && (
              <div className="mt-1 text-red-700">⛔ 该节点是硬性死线，不允许内部原因延期</div>
            )}
          </>
        )}
      </div>

      {/* 详细原因 */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          详细说明 <span className="text-red-500">*</span>
        </label>
        <textarea
          value={reasonDetail}
          onChange={(e) => setReasonDetail(e.target.value)}
          className="w-full rounded-md border border-gray-300 px-3 py-2 bg-white text-gray-900 placeholder-gray-400"
          rows={3}
          required
          placeholder="具体说明延期的情况、客户/供应商名称、影响范围..."
        />
      </div>

      {/* 新日期 */}
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
        {milestoneDueAt && (
          <p className="text-xs text-gray-500 mt-1">原截止：{milestoneDueAt.slice(0, 10)}</p>
        )}
      </div>

      {/* 实时校验结果 */}
      {validationResult && (
        <div className={`rounded-lg p-3 text-xs whitespace-pre-wrap ${
          validationResult.allowed
            ? 'bg-green-50 border border-green-200 text-green-800'
            : 'bg-red-50 border border-red-200 text-red-800'
        }`}>
          {validationResult.allowed ? '✅ ' : '❌ '}{validationResult.reason}
        </div>
      )}

      {/* 不可抗力 / 客户原因要求证据 */}
      {(category === 'force_majeure' || category === 'customer') && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            客户书面确认链接 {category === 'force_majeure' && <span className="text-red-500">*</span>}
          </label>
          <input
            type="url"
            value={customerEvidenceUrl}
            onChange={(e) => setCustomerEvidenceUrl(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 bg-white text-gray-900 placeholder-gray-400 text-sm"
            placeholder="邮件截图 / 微信聊天记录 / 签字文件 链接..."
          />
          <p className="text-xs text-gray-500 mt-1">
            {category === 'force_majeure'
              ? '⚠ 不可抗力必须有客户书面同意才能顺延交期'
              : '建议提供客户确认的邮件/聊天截图'}
          </p>
        </div>
      )}

      <button
        type="submit"
        disabled={loading || (validationResult && !validationResult.allowed)}
        className="w-full rounded-md bg-blue-600 px-4 py-2.5 text-white font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? '提交中...' : '提交延期申请'}
      </button>
    </form>
  );
}
