'use client';
import { useState } from 'react';
import { markMilestoneDone, markMilestoneBlocked } from '@/app/actions/milestones';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

interface MilestoneActionsProps {
  milestone: any;
  /** 同一订单内所有里程碑（用于阻断校验） */
  allMilestones?: any[];
  currentRole?: string;
  isAdmin?: boolean;
  orderId?: string;
}

export function MilestoneActions({
  milestone,
  allMilestones = [],
  currentRole,
  isAdmin = false,
  orderId,
}: MilestoneActionsProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [showSubmitForm, setShowSubmitForm] = useState(false);
  const [showBlockForm, setShowBlockForm] = useState(false);
  const [blockReason, setBlockReason] = useState('');
  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  const [evidenceNote, setEvidenceNote] = useState('');
  const [blockError, setBlockError] = useState('');
  const [submitError, setSubmitError] = useState('');

  const canModify = isAdmin ||
    (currentRole && currentRole.toLowerCase() === milestone.owner_role?.toLowerCase());

  // ── 阻断校验 ──────────────────────────────────────────────────
  function getBlockers(): string[] {
    if (!allMilestones.length) return [];
    // blocks 字段：记录哪些节点阻断了当前节点
    // 反向查找：哪些节点的 blocks 包含当前 step_key
    const blockedBy: string[] = [];
    for (const m of allMilestones) {
      const mBlocks: string[] = m.blocks || [];
      if (mBlocks.includes(milestone.step_key)) {
        const status = m.status;
        const isDone = status === '已完成' || status === 'done' || status === 'completed';
        if (!isDone) {
          blockedBy.push(m.name || m.step_key);
        }
      }
    }
    return blockedBy;
  }

  // ── 「去处理」提交（证据上传 → 完成）──────────────────────────
  async function handleSubmitEvidence(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError('');

    // 必须上传证据
    if (milestone.evidence_required && !evidenceFile) {
      setSubmitError('⚠️ 此节点需要上传凭证才能完成，请选择文件');
      return;
    }

    // 阻断校验
    const blockers = getBlockers();
    if (blockers.length > 0) {
      setSubmitError('⛔ 以下前置节点尚未完成，无法推进：\n' + blockers.map(b => '· ' + b).join('\n'));
      return;
    }

    setLoading(true);

    try {
      // 上传凭证文件
      if (evidenceFile && orderId) {
        const supabase = createClient();
        const ext = evidenceFile.name.split('.').pop() || 'bin';
        const path = orderId + '/milestones/' + milestone.step_key + '_' + Date.now() + '.' + ext;
        const { error: uploadError } = await supabase.storage
          .from('order-docs')
          .upload(path, evidenceFile, { contentType: evidenceFile.type, upsert: true });
        if (uploadError) {
          setSubmitError('文件上传失败：' + uploadError.message);
          setLoading(false);
          return;
        }
      }

      // 标记完成
      const result = await markMilestoneDone(milestone.id);
      if (result.error) {
        setSubmitError(result.error);
      } else {
        setShowSubmitForm(false);
        router.refresh();
      }
    } catch (err: any) {
      setSubmitError('操作失败：' + err.message);
    }
    setLoading(false);
  }

  // ── 「申请延期」提交 ───────────────────────────────────────────
  async function handleBlock() {
    setBlockError('');
    if (!blockReason.trim()) {
      setBlockError('请填写阻塞说明');
      return;
    }
    setLoading(true);
    const result = await markMilestoneBlocked(milestone.id, blockReason);
    if (!result.error) {
      setShowBlockForm(false);
      setBlockReason('');
      router.refresh();
    } else {
      setBlockError(result.error);
    }
    setLoading(false);
  }

  // ── 已完成状态 ─────────────────────────────────────────────────
  if (milestone.status === '已完成' || milestone.status === 'done') {
    return (
      <div className="flex items-center gap-2 text-green-700 text-sm font-medium bg-green-50 px-3 py-2 rounded-lg">
        <span>✓</span>
        <span>已完成</span>
      </div>
    );
  }

  const isActive = milestone.status === '进行中' || milestone.status === 'in_progress';
  if (!isActive) return null;

  const blockers = getBlockers();
  const isBlocked = blockers.length > 0;

  return (
    <div className="space-y-3">

      {/* 阻断提示 */}
      {isBlocked && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-3">
          <p className="text-sm font-semibold text-red-800 mb-1">⛔ 前置节点未完成，当前节点被锁定</p>
          <ul className="space-y-0.5">
            {blockers.map(b => (
              <li key={b} className="text-xs text-red-700">· {b}</li>
            ))}
          </ul>
        </div>
      )}

      {/* 凭证说明 */}
      {milestone.evidence_note && !showSubmitForm && !isBlocked && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 p-3">
          <p className="text-xs font-medium text-amber-800 mb-1">📋 需要提交的凭证：</p>
          <p className="text-xs text-amber-700">{milestone.evidence_note}</p>
        </div>
      )}

      {/* 操作按钮 */}
      {canModify && !isBlocked && (
        <div className="flex gap-2">
          <button
            onClick={() => { setShowSubmitForm(!showSubmitForm); setShowBlockForm(false); }}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white font-medium hover:bg-indigo-700 disabled:opacity-50"
          >
            📤 去处理
          </button>
          <button
            onClick={() => { setShowBlockForm(!showBlockForm); setShowSubmitForm(false); }}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-lg border border-orange-300 px-4 py-2 text-sm text-orange-700 font-medium hover:bg-orange-50 disabled:opacity-50"
          >
            🚧 申请延期
          </button>
        </div>
      )}

      {/* 「去处理」表单 */}
      {showSubmitForm && canModify && !isBlocked && (
        <form onSubmit={handleSubmitEvidence}
          className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 space-y-4">
          <p className="text-sm font-semibold text-indigo-900">提交处理凭证</p>

          {milestone.evidence_note && (
            <div className="text-xs text-indigo-700 bg-white rounded-lg p-2 border border-indigo-200">
              📋 {milestone.evidence_note}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              上传凭证文件
              {milestone.evidence_required && <span className="text-red-500 ml-1">*必传</span>}
            </label>
            <input
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.xlsx,.xls,.doc,.docx"
              onChange={e => setEvidenceFile(e.target.files?.[0] || null)}
              className="block w-full text-sm text-gray-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-white file:text-indigo-700 hover:file:bg-indigo-50 cursor-pointer"
            />
            <p className="text-xs text-gray-400 mt-1">支持 PDF、图片、Excel、Word</p>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">处理备注（选填）</label>
            <textarea
              value={evidenceNote}
              onChange={e => setEvidenceNote(e.target.value)}
              rows={2}
              placeholder="说明处理结果或备注..."
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white focus:outline-none focus:border-indigo-400"
            />
          </div>

          {submitError && (
            <div className="rounded-lg bg-red-50 border border-red-200 p-3">
              <p className="text-xs text-red-700 whitespace-pre-line">{submitError}</p>
            </div>
          )}

          <div className="flex gap-2">
            <button type="submit" disabled={loading}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white font-medium hover:bg-indigo-700 disabled:opacity-50">
              {loading ? '提交中...' : '✅ 确认完成'}
            </button>
            <button type="button"
              onClick={() => { setShowSubmitForm(false); setSubmitError(''); }}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">
              取消
            </button>
          </div>
        </form>
      )}

      {/* 「申请延期」表单 */}
      {showBlockForm && canModify && (
        <div className="rounded-xl border border-orange-200 bg-orange-50 p-4 space-y-3">
          <p className="text-sm font-semibold text-orange-900">申请延期 / 标记阻塞</p>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              阻塞说明 <span className="text-red-500">*</span>
            </label>
            <textarea
              value={blockReason}
              onChange={e => setBlockReason(e.target.value)}
              rows={3}
              placeholder="说明阻塞说明、需要哪些帮助..."
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white focus:outline-none focus:border-orange-400"
            />
          </div>
          {blockError && <p className="text-xs text-red-600">{blockError}</p>}
          <div className="flex gap-2">
            <button onClick={handleBlock} disabled={loading || !blockReason.trim()}
              className="rounded-lg bg-orange-500 px-4 py-2 text-sm text-white font-medium hover:bg-orange-600 disabled:opacity-50">
              {loading ? '提交中...' : '确认上报'}
            </button>
            <button onClick={() => { setShowBlockForm(false); setBlockReason(''); setBlockError(''); }}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
