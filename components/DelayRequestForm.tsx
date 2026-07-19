'use client';

import { useState, useEffect } from 'react';
import { createDelayRequest } from '@/app/actions/delays';
import { useRouter } from 'next/navigation';
import type { Milestone } from '@/lib/types';
import { DELAY_CATEGORIES, validateDelayRequest, type DelayCategory } from '@/lib/domain/delay-rules';

interface DelayRequestFormProps {
  milestoneId: string;
  milestone: Milestone;
  orderIncoterm: 'FOB' | 'DDP';
  milestoneDueAt: string | null;
}

export function DelayRequestForm({ milestoneId, milestone, orderIncoterm, milestoneDueAt }: DelayRequestFormProps) {
  const router = useRouter();
  const [category, setCategory] = useState<DelayCategory>('customer');
  const [mode, setMode] = useState<'push_delivery' | 'hold_delivery'>('push_delivery');  // 强制二选一
  const [reasonDetail, setReasonDetail] = useState('');
  const [proposedNewDueAt, setProposedNewDueAt] = useState('');
  const [customerEvidenceUrl, setCustomerEvidenceUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationResult, setValidationResult] = useState<any>(null);

  const stepKey = (milestone as any).step_key || '';
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
      mode,
    });
    setValidationResult(result);
  }, [category, mode, proposedNewDueAt, milestoneDueAt, stepKey]);

  // 分类切换时给个默认建议:客户/不可抗力 → 顺延交期;内部/供应商 → 保交期(可手动改)
  useEffect(() => {
    setMode(categoryInfo.impactsFinalDeliveryDate ? 'push_delivery' : 'hold_delivery');
  }, [category, categoryInfo.impactsFinalDeliveryDate]);

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

    // 强制二选一:始终传节点新日期,顺延/保交期交给 mode,新交期由服务端 = 原交期 + 延期天数 算(不再把节点日期当交期)
    const result = await createDelayRequest(
      milestoneId,
      category, // 使用 category 作为 reasonType
      reasonDetail,
      undefined,                     // anchor 由服务端按 mode 计算
      proposedNewDueAt,              // 节点新截止(始终传)
      category === 'force_majeure',
      customerEvidenceUrl || undefined,
      category,
      mode,                          // push_delivery=顺延交期 / hold_delivery=保交期
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

      {/* 强制二选一:顺延交期 / 保交期(下游必动) */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          这次延期怎么处理交期? <span className="text-red-500">*</span>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={() => setMode('push_delivery')}
            className={`text-left p-3 rounded-lg border-2 transition-all ${mode === 'push_delivery' ? 'border-blue-500 bg-blue-50' : 'border-gray-200'}`}>
            <div className="font-semibold text-sm text-gray-900">📅 顺延交期</div>
            <div className="text-xs text-gray-500 mt-1 leading-snug">交期({orderIncoterm === 'FOB' ? 'ETD' : '入仓日'}) 和所有下游节点一起后移相同天数</div>
          </button>
          <button type="button" onClick={() => setMode('hold_delivery')}
            className={`text-left p-3 rounded-lg border-2 transition-all ${mode === 'hold_delivery' ? 'border-amber-500 bg-amber-50' : 'border-gray-200'}`}>
            <div className="font-semibold text-sm text-gray-900">⚡ 保交期</div>
            <div className="text-xs text-gray-500 mt-1 leading-snug">客户承诺交期不变;内部节点可按实际需要延期,超缓冲会提示风险并走现有审批</div>
          </button>
        </div>
        {mode === 'hold_delivery' && proposedNewDueAt && validationResult && (
          <div className={`mt-1.5 text-xs ${validationResult.allowed ? 'text-amber-700' : 'text-red-700'}`}>
            {validationResult.remainingBufferDays == null
              ? `当前节点缺少缓冲基线，系统将按实际日期提交保交期延期 ${validationResult.delayDays || 0} 天`
              : validationResult.remainingBufferDays >= 0
                ? `剩余缓冲 ${validationResult.remainingBufferDays} 天`
                : `已超出缓冲 ${Math.abs(validationResult.remainingBufferDays)} 天，将提示高风险并继续走审批`}
          </div>
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
