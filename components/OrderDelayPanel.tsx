'use client';

/**
 * 订单整单延期面板
 *
 * 业务场景：生产卡住，业务与客户协商延期。原来只能在 OverdueOrderGate
 *   (factory_date 已过) 时触发；现在订单详情页随时可申请整单延期。
 *
 * 行为：
 *   1. 顶部 banner：「已延期 N 次」（N>=1 显示），点击展开历史时间线
 *   2. 「申请整单延期」按钮 — 业务/admin 可见
 *   3. 弹窗收集：原因类型/详情/新出厂日/客户证据上传（客户原因必传）
 *   4. 提交后走 createOrderLevelDelayRequest action → 走标准审批 → 审批通过
 *      后自动 recalculateSchedule（已有基建）
 */

import { useState, useRef } from 'react';
import Link from 'next/link';
import { isApprovalPending } from '@/lib/domain/types';
import { useRouter } from 'next/navigation';
import { createOrderLevelDelayRequest } from '@/app/actions/delays';
import { createClient } from '@/lib/supabase/client';
import { formatDate } from '@/lib/utils/date';

interface DelayRecord {
  id: string;
  status: 'pending' | 'approved' | 'rejected';
  reason_category: 'customer' | 'supplier' | 'internal' | 'force_majeure' | string;
  reason_type?: string | null;
  reason_detail: string;
  proposed_new_anchor_date: string | null;
  requires_customer_approval?: boolean;
  customer_approval_evidence_url?: string | null;
  delay_days?: number | null;
  created_at: string;
  approved_at?: string | null;
  decision_note?: string | null;
  requested_by_name?: string | null;
}

interface Props {
  orderId: string;
  orderNo: string;
  customerName: string;
  currentFactoryDate: string | null;
  incoterm: string;
  delayHistory: DelayRecord[];
  /** 当前用户是否可申请延期（订单创建者/owner/sales/merchandiser/admin）*/
  canRequestDelay: boolean;
  /** 当前用户角色 — 仅 admin 可看审批操作（这里只展示）*/
  isAdmin: boolean;
}

const CATEGORY_LABEL: Record<string, string> = {
  customer: '客户原因',
  supplier: '供应商问题',
  internal: '内部延误',
  force_majeure: '不可抗力',
};

const CATEGORY_COLOR: Record<string, string> = {
  customer: 'bg-blue-100 text-blue-800',
  supplier: 'bg-orange-100 text-orange-800',
  internal: 'bg-red-100 text-red-800',
  force_majeure: 'bg-purple-100 text-purple-800',
};

const STATUS_LABEL: Record<string, string> = {
  pending: '待审批',
  approved: '已批准',
  rejected: '已驳回',
};

const STATUS_COLOR: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-800',
  approved: 'bg-green-100 text-green-800',
  rejected: 'bg-gray-100 text-gray-600',
};

export function OrderDelayPanel({
  orderId,
  orderNo,
  customerName,
  currentFactoryDate,
  incoterm,
  delayHistory,
  canRequestDelay,
  isAdmin,
}: Props) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [reasonCategory, setReasonCategory] = useState<'customer' | 'supplier' | 'internal' | 'force_majeure'>('customer');
  const [reasonType, setReasonType] = useState('');
  const [reasonDetail, setReasonDetail] = useState('');
  const [newFactoryDate, setNewFactoryDate] = useState('');
  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  const evidenceInputRef = useRef<HTMLInputElement>(null);

  const approvedCount = delayHistory.filter(d => d.status === 'approved').length;
  const pendingCount = delayHistory.filter(d => isApprovalPending(d.status)).length;
  const totalCount = delayHistory.length;

  // 客户原因必须上传客户同意证据
  const evidenceRequired = reasonCategory === 'customer';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!reasonType.trim()) return setError('请填写延期原因类型（如：客户改款 / 面料缺货 / 工厂产能不足）');
    if (!reasonDetail.trim() || reasonDetail.trim().length < 10) return setError('请填写详细说明（至少 10 字）');
    if (!newFactoryDate) return setError('请选择新出厂日期');
    if (newFactoryDate <= new Date().toISOString().slice(0, 10)) return setError('新出厂日必须晚于今天');
    if (evidenceRequired && !evidenceFile) return setError('客户原因必须上传客户同意证据（邮件截图/聊天记录/PDF）');

    setSubmitting(true);
    try {
      // 1. 上传证据文件到 storage（如果有）
      let evidenceUrl: string | null = null;
      if (evidenceFile) {
        const supabase = createClient();
        const ext = evidenceFile.name.split('.').pop() || 'bin';
        const path = `delay-evidence/${orderId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const { error: upErr } = await supabase.storage.from('attachments').upload(path, evidenceFile);
        if (upErr) {
          setError(`证据文件上传失败：${upErr.message}`);
          setSubmitting(false);
          return;
        }
        const { data: pub } = supabase.storage.from('attachments').getPublicUrl(path);
        evidenceUrl = pub.publicUrl;
      }

      // 2. 创建延期申请
      const result = await createOrderLevelDelayRequest(
        orderId,
        reasonCategory,
        reasonType.trim(),
        reasonDetail.trim(),
        newFactoryDate,
      );
      if (result.error) {
        setError(result.error);
        setSubmitting(false);
        return;
      }

      // 3. 把 evidence URL 写到刚创建的延期申请（如果有）
      if (evidenceUrl && (result as any).delayRequestId) {
        const supabase = createClient();
        await (supabase.from('delay_requests') as any)
          .update({ customer_approval_evidence_url: evidenceUrl })
          .eq('id', (result as any).delayRequestId);
      }

      alert('✅ 延期申请已提交，等待 CEO 审批。审批通过后系统将自动重排下游节点。');
      setShowForm(false);
      // 重置表单
      setReasonCategory('customer');
      setReasonType('');
      setReasonDetail('');
      setNewFactoryDate('');
      setEvidenceFile(null);
      if (evidenceInputRef.current) evidenceInputRef.current.value = '';
      router.refresh();
    } catch (e: any) {
      setError(`提交异常：${e?.message || '未知错误'}`);
    } finally {
      setSubmitting(false);
    }
  };

  // 没有延期且不可申请 → 不显示任何东西
  if (totalCount === 0 && !canRequestDelay) return null;

  return (
    <div className="rounded-xl border bg-white">
      {/* Header: badge + 按钮 */}
      <div className={`px-4 py-3 flex items-center justify-between gap-3 ${approvedCount > 0 ? 'bg-amber-50 border-b border-amber-200' : 'border-b border-gray-100'}`}>
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-base">⏱️</span>
          {totalCount === 0 ? (
            <span className="text-sm text-gray-600">订单暂无延期记录</span>
          ) : (
            <>
              <span className="text-sm font-semibold text-amber-900">
                已延期 {approvedCount} 次
                {pendingCount > 0 && <span className="ml-2 text-amber-700">· 待审批 {pendingCount} 条</span>}
              </span>
              <button
                onClick={() => setExpanded(!expanded)}
                className="text-xs text-amber-700 hover:text-amber-900 underline"
              >
                {expanded ? '收起历史' : '查看延期历史'}
              </button>
              {/* 有待审批的延期 → 直达审批页(delays 标签不在导航栏,靠此按钮进入;审批权限由该页把关)*/}
              {pendingCount > 0 && (
                <Link
                  href={`/orders/${orderId}?tab=delays#delay-approve`}
                  scroll
                  className="text-xs px-2 py-1 rounded-lg bg-amber-600 text-white font-medium hover:bg-amber-700 shrink-0"
                >
                  ✅ 去审批
                </Link>
              )}
            </>
          )}
        </div>
        {canRequestDelay && (
          <button
            onClick={() => setShowForm(!showForm)}
            className="text-xs px-3 py-1.5 rounded-lg bg-amber-600 text-white font-medium hover:bg-amber-700 shrink-0"
          >
            {showForm ? '取消申请' : '📅 申请整单延期'}
          </button>
        )}
      </div>

      {/* 延期历史时间线 */}
      {expanded && totalCount > 0 && (
        <div className="px-4 py-3 space-y-3 border-b border-gray-100 bg-gray-50">
          {delayHistory.map((d, i) => (
            <div key={d.id} className="rounded-lg bg-white border border-gray-200 p-3">
              <div className="flex items-center justify-between gap-2 mb-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-semibold text-gray-700">第 {totalCount - i} 次延期</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${CATEGORY_COLOR[d.reason_category] || 'bg-gray-100 text-gray-700'}`}>
                    {CATEGORY_LABEL[d.reason_category] || d.reason_category}
                  </span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${STATUS_COLOR[d.status] || 'bg-gray-100'}`}>
                    {STATUS_LABEL[d.status] || d.status}
                  </span>
                  {d.delay_days != null && d.delay_days > 0 && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-medium">
                      延 {d.delay_days} 天
                    </span>
                  )}
                </div>
                <span className="text-[11px] text-gray-400 shrink-0">{formatDate(d.created_at)}</span>
              </div>

              {d.reason_type && (
                <p className="text-xs text-gray-700 mt-1"><strong>原因类型：</strong>{d.reason_type}</p>
              )}
              <p className="text-xs text-gray-700 mt-0.5"><strong>详细说明：</strong>{d.reason_detail}</p>

              {d.proposed_new_anchor_date && (
                <p className="text-xs text-gray-700 mt-0.5">
                  <strong>新出厂日：</strong>
                  <span className="ml-1 px-1.5 py-0.5 rounded bg-amber-100 text-amber-900 font-medium">
                    {String(d.proposed_new_anchor_date).slice(0, 10)}
                  </span>
                </p>
              )}

              {d.customer_approval_evidence_url ? (
                <p className="text-xs mt-1">
                  <strong className="text-gray-700">客户同意证据：</strong>
                  <a
                    href={d.customer_approval_evidence_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-1 text-blue-600 hover:underline"
                  >
                    📎 查看证据
                  </a>
                </p>
              ) : d.requires_customer_approval && d.reason_category === 'customer' ? (
                <p className="text-xs text-red-600 mt-1">⚠️ 此延期标记需客户同意但缺少证据</p>
              ) : null}

              {d.decision_note && (
                <p className="text-xs text-gray-500 mt-1 italic">审批备注：{d.decision_note}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 申请表单 */}
      {showForm && (
        <form onSubmit={handleSubmit} className="px-4 py-4 space-y-3">
          <h4 className="text-sm font-semibold text-gray-900">申请整单延期 — {orderNo}（{customerName}）</h4>

          <div className="text-xs text-gray-500">
            当前出厂日：<strong>{currentFactoryDate ? String(currentFactoryDate).slice(0, 10) : '未设定'}</strong>
            {incoterm && <span className="ml-3">贸易条款：{incoterm}</span>}
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">原因类型 <span className="text-red-500">*</span></label>
            <div className="flex flex-wrap gap-2">
              {(['customer', 'supplier', 'internal', 'force_majeure'] as const).map(k => (
                <label key={k} className={`text-xs px-3 py-1.5 rounded-full cursor-pointer border ${
                  reasonCategory === k
                    ? `${CATEGORY_COLOR[k]} border-transparent font-semibold`
                    : 'bg-white text-gray-600 border-gray-300 hover:border-gray-400'
                }`}>
                  <input
                    type="radio"
                    name="reason_category"
                    value={k}
                    checked={reasonCategory === k}
                    onChange={() => setReasonCategory(k)}
                    className="hidden"
                  />
                  {CATEGORY_LABEL[k]}
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">具体原因 <span className="text-red-500">*</span></label>
            <input
              type="text"
              value={reasonType}
              onChange={(e) => setReasonType(e.target.value)}
              placeholder="例：客户改款 / 面料缺货 / 工厂产能不足 / 港口罢工"
              className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">详细说明 <span className="text-red-500">*</span>（至少 10 字）</label>
            <textarea
              value={reasonDetail}
              onChange={(e) => setReasonDetail(e.target.value)}
              rows={3}
              placeholder="说明为什么需要延期、推迟多少时间、对客户的影响如何沟通的"
              className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">新出厂日期 <span className="text-red-500">*</span></label>
            <input
              type="date"
              value={newFactoryDate}
              onChange={(e) => setNewFactoryDate(e.target.value)}
              min={new Date(Date.now() + 86400000).toISOString().slice(0, 10)}
              className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
            <p className="text-[11px] text-gray-400 mt-1">审批通过后下游节点（订舱/报关/出运）会自动按新出厂日重排</p>
          </div>

          <div className={evidenceRequired ? 'rounded-lg bg-blue-50 border border-blue-200 p-3' : ''}>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              客户同意证据 {evidenceRequired && <span className="text-red-500">*（客户原因必传）</span>}
            </label>
            <input
              ref={evidenceInputRef}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.heic,.webp"
              onChange={(e) => setEvidenceFile(e.target.files?.[0] || null)}
              className="block w-full text-sm text-gray-500 file:mr-3 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-blue-100 file:text-blue-700 hover:file:bg-blue-200"
            />
            <p className="text-[11px] text-gray-500 mt-1">
              {evidenceRequired
                ? '邮件截图 / WhatsApp/微信聊天记录 / 客户签字 PDF 等'
                : '可选 — 如有客户或供应商书面确认可上传'}
            </p>
            {evidenceFile && (
              <p className="text-[11px] text-green-600 mt-1">✓ 已选择：{evidenceFile.name}</p>
            )}
          </div>

          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-800">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setShowForm(false)}
              disabled={submitting}
              className="px-4 py-2 rounded-lg border border-gray-300 text-sm text-gray-700 hover:bg-gray-50"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 rounded-lg bg-amber-600 text-white text-sm font-medium hover:bg-amber-700 disabled:opacity-50"
            >
              {submitting ? '提交中…' : '提交延期申请'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
