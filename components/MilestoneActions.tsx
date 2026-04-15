'use client';
import { useState, useEffect, useRef } from 'react';
import { markMilestoneDone, markMilestoneBlocked, saveChecklistData } from '@/app/actions/milestones';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { isDoneStatus, isActiveStatus, isPendingStatus } from '@/lib/domain/types';
import { AIAdviceBox } from '@/components/AIAdviceBox';
import { getChecklistForStep, type ChecklistConfig, type ChecklistItemResponse } from '@/lib/domain/checklist';
import { detectDefectsForMilestone } from '@/app/actions/defect-detect';
import type { DefectDetectionResult } from '@/lib/agent/skills/garmentDefectDetect';

const QC_STEPS = new Set([
  'pre_production_sample_ready', 'materials_received_inspected', 'production_kickoff',
  'mid_qc_check', 'mid_qc_sales_check', 'final_qc_check', 'final_qc_sales_check',
  'packing_method_confirmed', 'inspection_release',
]);

interface MilestoneActionsProps {
  milestone: any;
  /** 同一订单内所有里程碑（用于阻断校验） */
  allMilestones?: any[];
  currentRole?: string;
  /** 多角色支持 */
  currentRoles?: string[];
  isAdmin?: boolean;
  orderId?: string;
}

export function MilestoneActions({
  milestone,
  allMilestones = [],
  currentRole,
  currentRoles = [],
  isAdmin = false,
  orderId,
}: MilestoneActionsProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [showSubmitForm, setShowSubmitForm] = useState(false);
  const [showBlockForm, setShowBlockForm] = useState(false);
  const [blockReason, setBlockReason] = useState('');
  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  const [extraFiles, setExtraFiles] = useState<File[]>([]);
  const [evidenceNote, setEvidenceNote] = useState('');
  const [blockError, setBlockError] = useState('');
  const [submitError, setSubmitError] = useState('');
  // 检查清单响应数据的引用，供提交时自动保存
  const checklistResponsesRef = useRef<Record<string, { value: any; pending_date?: string }> | null>(null);
  // AI 质检
  const [aiQcLoading, setAiQcLoading] = useState(false);
  const [aiQcResult, setAiQcResult] = useState<DefectDetectionResult | null>(null);
  const showAiQc = QC_STEPS.has(milestone.step_key);

  // 多角色匹配：用户任一角色匹配节点 owner_role 即可操作
  // 管理员不在此列（管理员监督不替代执行，与服务端权限一致）
  const allRoles = currentRoles.length > 0 ? currentRoles : (currentRole ? [currentRole] : []);
  const isAdminOnly = allRoles.includes('admin');
  const ownerRole = (milestone.owner_role || '').toLowerCase();
  // 角色合并：production/qc/quality 都归入 merchandiser
  // 管理员禁止标记完成（与服务端一致）
  const canModify = !isAdminOnly && allRoles.some(r => {
    const nr = r.toLowerCase();
    if (nr === 'admin') return false; // 跳过admin角色
    if (nr === ownerRole) return true;
    // 业务/理单互通
    if ((ownerRole === 'sales' && nr === 'merchandiser') || (ownerRole === 'merchandiser' && nr === 'sales')) return true;
    // 生产/质检/品控 → 跟单
    const merchGroup = ['merchandiser', 'production', 'qc', 'quality'];
    if (merchGroup.includes(ownerRole) && merchGroup.includes(nr)) return true;
    // 行政督察可操作需要双签的节点（如评审会）
    if (nr === 'admin_assistant' && ownerRole === 'sales') return true;
    return false;
  });

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
        const isDone = isDoneStatus(status);
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

    const form = e.target as HTMLFormElement;

    // 财务审核：必须填内部订单号
    const internalOrderNo = (form.querySelector('input[name="internal_order_no"]') as HTMLInputElement)?.value?.trim();
    if (milestone.step_key === 'finance_approval' && !internalOrderNo) {
      setSubmitError('⚠️ 请填写内部订单号（实体订单册编号）');
      return;
    }

    // 产前样寄出：必须填快递单号
    const trackingNumber = (form.querySelector('input[name="tracking_number"]') as HTMLInputElement)?.value?.trim();
    if (milestone.step_key === 'pre_production_sample_sent' && !trackingNumber) {
      setSubmitError('⚠️ 请填写快递单号');
      return;
    }

    // 必须上传证据
    if (milestone.evidence_required && !evidenceFile) {
      setSubmitError('⚠️ 此节点需要上传凭证才能完成，请选择文件');
      return;
    }

    // 生产单上传：前端校验两个文件（生产订单 + 原辅料单），包装资料拆到包装确认节点
    if (milestone.step_key === 'production_order_upload') {
      const hasTrims = extraFiles.some((f: any) => f._fileType === 'trims_sheet');
      const missing: string[] = [];
      if (!evidenceFile) missing.push('生产订单');
      if (!hasTrims) missing.push('原辅料单');
      if (missing.length > 0) {
        setSubmitError(`⚠️ 生产单上传需要两个文件：\n缺少：${missing.join('、')}\n（包装资料可以晚些上传，最晚在「包装方式确认」前 1 周）`);
        return;
      }
    }

    // 包装方式确认：需要包装资料
    if (milestone.step_key === 'packing_method_confirmed') {
      const hasPacking = evidenceFile || extraFiles.some((f: any) => f._fileType === 'packing_requirement');
      if (!hasPacking) {
        setSubmitError('⚠️ 包装方式确认需要上传"包装资料"文件');
        return;
      }
    }

    // 阻断校验
    const blockers = getBlockers();
    if (blockers.length > 0) {
      setSubmitError('⛔ 以下前置节点尚未完成，无法推进：\n' + blockers.map(b => '· ' + b).join('\n'));
      return;
    }

    setLoading(true);

    try {
      // 上传凭证文件（同时写入 storage + attachments 表）
      if (evidenceFile && orderId) {
        const supabase = createClient();
        const fileType = (evidenceFile as any)._fileType || 'evidence';
        const ext = evidenceFile.name.split('.').pop() || 'bin';
        const path = orderId + '/milestones/' + milestone.step_key + '_' + fileType + '_' + Date.now() + '.' + ext;
        const { error: uploadError } = await supabase.storage
          .from('order-docs')
          .upload(path, evidenceFile, { contentType: evidenceFile.type, upsert: true });
        if (uploadError) {
          const msg = String(uploadError.message || '');
          const friendly = msg.includes('exceeded the maximum allowed size') || msg.includes('Payload too large')
            ? `⚠️ 文件过大，Supabase 存储拒收：${evidenceFile.name}（${(evidenceFile.size / 1024 / 1024).toFixed(1)}MB）。请压缩后重试（推荐 ≤ 10MB）。`
            : `文件上传失败：${msg}`;
          setSubmitError(friendly);
          setLoading(false);
          return;
        }
        const { data: { publicUrl } } = supabase.storage.from('order-docs').getPublicUrl(path);
        const { data: { user } } = await supabase.auth.getUser();
        // 写入 order_attachments 表（带 file_type 标记）
        await (supabase.from('order_attachments') as any).insert({
          order_id: orderId,
          milestone_id: milestone.id,
          uploaded_by: user?.id || null,
          file_name: evidenceFile.name,
          file_url: publicUrl,
          file_type: fileType,
          mime_type: evidenceFile.type || null,
        });
      }

      // 上传额外文件（多文件支持，带 file_type 标记）
      if (extraFiles.length > 0 && orderId) {
        const supabase2 = createClient();
        const { data: { user: u2 } } = await supabase2.auth.getUser();
        for (const file of extraFiles) {
          const fileType = (file as any)._fileType || 'evidence';
          const ext2 = file.name.split('.').pop() || 'bin';
          const path2 = orderId + '/milestones/' + milestone.step_key + '_' + fileType + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6) + '.' + ext2;
          await supabase2.storage.from('order-docs').upload(path2, file, { contentType: file.type, upsert: true });
          const { data: { publicUrl: url2 } } = supabase2.storage.from('order-docs').getPublicUrl(path2);
          await (supabase2.from('order_attachments') as any).insert({
            order_id: orderId, milestone_id: milestone.id,
            uploaded_by: u2?.id || null, file_name: file.name, file_url: url2,
            file_type: fileType, mime_type: file.type || null,
          });
        }
      }

      // 保存内部订单号到 orders 表
      if (internalOrderNo && orderId) {
        const supabaseForOrder = createClient();
        await (supabaseForOrder.from('orders') as any)
          .update({ internal_order_no: internalOrderNo })
          .eq('id', orderId);
      }

      // 保存快递单号到备注
      if (trackingNumber) {
        const supabaseForNote = createClient();
        await (supabaseForNote.from('milestones') as any)
          .update({ notes: `快递单号: ${trackingNumber}${evidenceNote ? '\n' + evidenceNote : ''}` })
          .eq('id', milestone.id);
      }

      // 收集检查清单数据 — 只提交当前用户角色能编辑的字段
      let checklistPayload: Array<{ key: string; value: any; pending_date?: string }> | null = null;
      if (checklistResponsesRef.current && Object.keys(checklistResponsesRef.current).length > 0) {
        const { getChecklistForStep } = await import('@/lib/domain/checklist');
        const clConfig = getChecklistForStep(milestone.step_key);
        const userRolesLower = allRoles.map((r: string) => r.toLowerCase());
        const isAdminRole = userRolesLower.includes('admin');

        checklistPayload = Object.entries(checklistResponsesRef.current)
          .filter(([key]) => {
            if (!clConfig) return true;
            const itemDef = clConfig.items.find((i: any) => i.key === key);
            if (!itemDef) return true;
            // admin 可以编辑所有非严格字段
            if (isAdminRole) return true;
            // 只提交自己角色能编辑的字段
            const itemRole = itemDef.role.toLowerCase();
            return userRolesLower.includes(itemRole)
              || (itemRole === 'sales' && userRolesLower.includes('merchandiser'))
              || (itemRole === 'merchandiser' && userRolesLower.includes('sales'));
          })
          .map(([key, r]) => {
            const item: { key: string; value: any; pending_date?: string } = { key, value: r.value ?? null };
            if (r.pending_date) item.pending_date = r.pending_date;
            return item;
          });
        if (checklistPayload.length === 0) checklistPayload = null;
      }

      // 标记完成（服务端会先保存清单再验证）
      const result = await markMilestoneDone(milestone.id, checklistPayload);
      if (result.error) {
        setSubmitError(result.error);
      } else {
        setShowSubmitForm(false);
        router.refresh();
      }
    } catch (err: any) {
      // 如果是 Next.js 通用错误，给出更友好提示
      const msg = err?.message || '';
      if (msg.includes('Server Components') || msg.includes('server')) {
        setSubmitError('提交失败，请刷新页面后重试。如仍失败请联系管理员。');
      } else {
        setSubmitError('操作失败：' + msg);
      }
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

  // ── 已完成状态（支持补传文件）─────────────────────────────────────
  if (isDoneStatus(milestone.status)) {
    // 生产单上传节点：分卡上传（生产订单 + 包装资料）
    const isProductionUpload = milestone.step_key === 'production_order_upload';
    const needsEvidence = milestone.evidence_required;

    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-green-700 text-sm font-medium bg-green-50 px-3 py-2 rounded-lg">
          <span>✓</span>
          <span>已完成</span>
        </div>
        {/* 补传文件区域 */}
        {(needsEvidence || isProductionUpload) && canModify && (
          <CompletedFileUpload
            milestoneId={milestone.id}
            orderId={orderId || ''}
            stepKey={milestone.step_key}
            isProductionUpload={isProductionUpload}
          />
        )}
      </div>
    );
  }

  // 「进行中」or「pending 但已逾期」or「pending 但有操作权限的用户」都可操作
  const isInProgress = isActiveStatus(milestone.status);
  const isPending = isPendingStatus(milestone.status);
  const isPendingOverdue = isPending && milestone.due_at && new Date(milestone.due_at) < new Date();
  const isDone = isDoneStatus(milestone.status);
  const isActive = isInProgress || (isPending && canModify);
  // 生产单上传：完成后仍允许补传文件
  const allowSupplementUpload = isDone && milestone.step_key === 'production_order_upload' && canModify;
  if (!isActive && !allowSupplementUpload) return null;

  const blockers = getBlockers();
  const isBlocked = blockers.length > 0;

  // 补传模式：生产单已完成，只显示上传区
  if (allowSupplementUpload && !isActive) {
    return (
      <div className="space-y-3">
        <div className="rounded-lg bg-blue-50 border border-blue-200 p-3">
          <p className="text-xs text-blue-700">✅ 此节点已完成。可继续补传资料文件。</p>
        </div>
        <SupplementaryUpload milestoneId={milestone.id} orderId={orderId || ''} stepKey={milestone.step_key} />
      </div>
    );
  }

  return (
    <div className="space-y-3">

      {/* 阻断提示 */}
      {isBlocked && canModify && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 p-3">
          <p className="text-sm font-semibold text-amber-800 mb-1">⚠ 以下前置节点尚未完成：</p>
          <ul className="space-y-0.5">
            {blockers.map(b => (
              <li key={b} className="text-xs text-amber-700">· {b}（逾期）</li>
            ))}
          </ul>
          <p className="text-xs text-amber-600 mt-1">可以继续操作，但请尽快推进前置节点</p>
        </div>
      )}

      {/* 凭证说明 */}
      {milestone.evidence_note && !showSubmitForm && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 p-3">
          <p className="text-xs font-medium text-amber-800 mb-1">📋 需要提交的凭证：</p>
          <p className="text-xs text-amber-700">{milestone.evidence_note}</p>
        </div>
      )}

      {/* 操作按钮 — 前置未完成也允许操作，只显示警告 */}
      {canModify && (
        <div className="flex gap-2">
          <button
            onClick={() => { setShowSubmitForm(!showSubmitForm); setShowBlockForm(false); }}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white font-medium hover:bg-indigo-700 disabled:opacity-50"
          >
            📤 去处理
          </button>
          {/* 产前样客户确认：增加"未通过/需返样"按钮 */}
          {milestone.step_key === 'pre_production_sample_approved' && (
            <button
              onClick={async () => {
                if (!confirm('确认产前样未通过？系统将回退到「产前样准备完成」，开始二次样流程。')) return;
                setLoading(true);
                try {
                  const supabaseClient = createClient();
                  // 回退：将 pre_production_sample_ready, pre_production_sample_sent 重新设为 pending
                  // 当前节点（approved）也设为 pending
                  const resetSteps = ['pre_production_sample_ready', 'pre_production_sample_sent', 'pre_production_sample_approved'];
                  for (const stepKey of resetSteps) {
                    const { data: ms } = await (supabaseClient.from('milestones') as any)
                      .select('id').eq('order_id', orderId).eq('step_key', stepKey).single();
                    if (ms) {
                      await (supabaseClient.from('milestones') as any)
                        .update({ status: stepKey === 'pre_production_sample_ready' ? 'in_progress' : 'pending', actual_at: null })
                        .eq('id', ms.id);
                    }
                  }
                  // 记录日志
                  const { data: { user } } = await supabaseClient.auth.getUser();
                  await (supabaseClient.from('milestone_logs') as any).insert({
                    milestone_id: milestone.id,
                    order_id: orderId,
                    actor_user_id: user?.id,
                    action: 'mark_blocked',
                    note: '产前样客户未通过，启动二次样流程',
                  });
                  router.refresh();
                } catch (err: any) {
                  alert('操作失败：' + err.message);
                }
                setLoading(false);
              }}
              disabled={loading}
              className="flex items-center gap-1.5 rounded-lg border border-red-300 px-4 py-2 text-sm text-red-700 font-medium hover:bg-red-50 disabled:opacity-50"
            >
              ❌ 未通过/需返样
            </button>
          )}
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
      {showSubmitForm && canModify && (
        <form onSubmit={handleSubmitEvidence}
          className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 space-y-4">
          <p className="text-sm font-semibold text-indigo-900">提交处理凭证</p>

          {/* AI 操作建议 */}
          <AIAdviceBox
            scene="milestone_action"
            orderId={orderId}
            milestoneStepKey={milestone.step_key}
            contextData={`正在处理节点「${milestone.name}」(${milestone.step_key})，负责角色：${milestone.owner_role}，截止日期：${milestone.due_at || '未设'}，当前状态：${milestone.status}`}
            compact
          />

          {milestone.evidence_note && (
            <div className="text-xs text-indigo-700 bg-white rounded-lg p-2 border border-indigo-200">
              📋 {milestone.evidence_note}
            </div>
          )}

          {/* 检查清单 */}
          <ChecklistSection
            milestone={milestone}
            orderId={orderId || ''}
            currentRoles={allRoles}
            onResponsesChange={(responses) => { checklistResponsesRef.current = responses; }}
          />

          {/* 生产单上传：2 个文件（生产订单 + 原辅料单）*/}
          {milestone.step_key === 'production_order_upload' ? (
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-2">
                上传生产资料 <span className="text-red-500">*生产订单 + 原辅料单 必传</span>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col items-center py-3 rounded-lg border-2 border-dashed border-indigo-300 text-xs text-indigo-600 cursor-pointer hover:bg-indigo-50">
                  📄 生产订单
                  <span className="text-[10px] text-gray-400 mt-0.5">AI可生成 或 手动上传</span>
                  <input type="file" className="hidden" accept=".pdf,.xlsx,.xls,.doc,.docx,.jpg,.jpeg,.png"
                    onChange={e => {
                      if (e.target.files?.[0]) {
                        setEvidenceFile(e.target.files[0]);
                        (e.target.files[0] as any)._fileType = 'production_order';
                      }
                    }} />
                </label>
                <label className="flex flex-col items-center py-3 rounded-lg border-2 border-dashed border-green-300 text-xs text-green-600 cursor-pointer hover:bg-green-50">
                  🧵 原辅料单
                  <span className="text-[10px] text-gray-400 mt-0.5">业务手动上传</span>
                  <input type="file" className="hidden" accept=".pdf,.xlsx,.xls,.doc,.docx,.jpg,.jpeg,.png"
                    onChange={e => {
                      if (e.target.files?.[0]) {
                        const f = e.target.files[0];
                        (f as any)._fileType = 'trims_sheet';
                        setExtraFiles(prev => [...prev.filter((p: any) => p._fileType !== 'trims_sheet'), f]);
                      }
                    }} />
                </label>
              </div>
              <p className="text-xs text-gray-400 mt-2">
                {evidenceFile ? `✅ 生产订单：${evidenceFile.name}` : '⬜ 生产订单：未选'}
                {' · '}
                {extraFiles.some((f: any) => f._fileType === 'trims_sheet') ? `✅ 原辅料单` : '⬜ 原辅料单：未选'}
              </p>
              <p className="text-xs text-amber-600 mt-1">💡 包装资料可以晚些上传，最晚在「包装方式确认」节点前 1 周</p>
            </div>
          ) : milestone.step_key === 'packing_method_confirmed' ? (
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-2">
                上传包装资料 <span className="text-red-500">*必传</span>
              </label>
              <label className="flex flex-col items-center py-4 rounded-lg border-2 border-dashed border-amber-300 text-xs text-amber-600 cursor-pointer hover:bg-amber-50">
                📦 包装资料
                <span className="text-[10px] text-gray-400 mt-0.5">包装方式 / 装箱要求 / 唛头等</span>
                <input type="file" className="hidden" accept=".pdf,.xlsx,.xls,.doc,.docx,.jpg,.jpeg,.png"
                  onChange={e => {
                    if (e.target.files?.[0]) {
                      setEvidenceFile(e.target.files[0]);
                      (e.target.files[0] as any)._fileType = 'packing_requirement';
                    }
                  }} />
              </label>
              <p className="text-xs text-gray-400 mt-2">
                {evidenceFile ? `✅ 已选：${evidenceFile.name}` : '⬜ 未选'}
              </p>
            </div>
          ) : (
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              {(() => {
                const labels: Record<string, string> = {
                  mid_qc_check: '上传中查报告',
                  final_qc_check: '上传尾查报告',
                  inspection_release: '上传验货报告 / 放行单',
                  po_confirmed: '上传客户PO',
                  order_docs_bom_complete: '上传BOM/订单资料',
                  bulk_materials_confirmed: '上传原辅料确认单',
                  procurement_order_placed: '上传采购单',
                  pre_production_sample_ready: '上传产前样照片',
                  pre_production_sample_approved: '上传客户确认记录',
                  booking_done: '上传订舱确认',
                  customs_export: '上传报关单据',
                };
                return labels[milestone.step_key] || '上传凭证文件';
              })()}
              {milestone.evidence_required && <span className="text-red-500 ml-1">*必传</span>}
            </label>
            <input
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.xlsx,.xls,.doc,.docx"
              multiple
              onChange={e => {
                const files = e.target.files;
                if (!files || files.length === 0) return;
                // 前端体积限制：单文件 20MB，总计 50MB — 避免 Supabase Storage 5xx
                const MAX_SINGLE_MB = 20;
                const MAX_TOTAL_MB = 50;
                const picked = Array.from(files);
                const oversized = picked.filter(f => f.size > MAX_SINGLE_MB * 1024 * 1024);
                if (oversized.length > 0) {
                  setSubmitError(
                    `⚠️ 文件超过 ${MAX_SINGLE_MB}MB 限制，无法上传：\n` +
                      oversized.map(f => `· ${f.name} (${(f.size / 1024 / 1024).toFixed(1)}MB)`).join('\n') +
                      `\n\n建议：压缩图片（画质降到 85%）或拆分 PDF`,
                  );
                  e.target.value = '';
                  return;
                }
                // 追加模式 — 允许多次选择累积
                const existingTotal =
                  (evidenceFile ? evidenceFile.size : 0) +
                  extraFiles.reduce((sum, f) => sum + f.size, 0);
                const newTotal = existingTotal + picked.reduce((sum, f) => sum + f.size, 0);
                if (newTotal > MAX_TOTAL_MB * 1024 * 1024) {
                  setSubmitError(
                    `⚠️ 累计文件超过 ${MAX_TOTAL_MB}MB 上限，请先移除部分文件或压缩后再上传`,
                  );
                  e.target.value = '';
                  return;
                }
                setSubmitError(null);
                // 第一次选：第一个当主凭证，其余当额外
                // 再次选：全部追加到 extraFiles
                if (!evidenceFile) {
                  setEvidenceFile(picked[0]);
                  setExtraFiles(prev => [...prev, ...picked.slice(1)]);
                } else {
                  setExtraFiles(prev => [...prev, ...picked]);
                }
                e.target.value = '';
              }}
              className="block w-full text-sm text-gray-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-white file:text-indigo-700 hover:file:bg-indigo-50 cursor-pointer"
            />
            <p className="text-xs text-gray-400 mt-1">
              支持 PDF、图片、Excel、Word · 单个 ≤ 20MB · 总计 ≤ 50MB · 可分多次选择
            </p>
            {(evidenceFile || extraFiles.length > 0) && (
              <div className="mt-2 space-y-1">
                {evidenceFile && (
                  <div className="flex items-center justify-between text-xs bg-indigo-50 px-2 py-1 rounded border border-indigo-100">
                    <span className="truncate text-indigo-700">
                      📎 {evidenceFile.name} <span className="text-gray-400">({(evidenceFile.size / 1024).toFixed(0)}KB)</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        if (extraFiles.length > 0) {
                          setEvidenceFile(extraFiles[0]);
                          setExtraFiles(extraFiles.slice(1));
                        } else {
                          setEvidenceFile(null);
                        }
                      }}
                      className="text-red-500 hover:text-red-700 ml-2 text-[10px]"
                    >
                      移除
                    </button>
                  </div>
                )}
                {extraFiles.map((f, i) => (
                  <div key={i} className="flex items-center justify-between text-xs bg-gray-50 px-2 py-1 rounded border border-gray-100">
                    <span className="truncate text-gray-700">
                      📎 {f.name} <span className="text-gray-400">({(f.size / 1024).toFixed(0)}KB)</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => setExtraFiles(prev => prev.filter((_, idx) => idx !== i))}
                      className="text-red-500 hover:text-red-700 ml-2 text-[10px]"
                    >
                      移除
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          )}

          {/* 财务审核：内部订单号 */}
          {milestone.step_key === 'finance_approval' && (
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                内部订单号（订单册编号）<span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                name="internal_order_no"
                required
                placeholder="输入实体订单册上的编号"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white focus:outline-none focus:border-indigo-400"
              />
              <p className="text-xs text-gray-400 mt-1">此编号将显示在订单详情中，方便与实体订单册对应</p>
            </div>
          )}

          {/* 产前样寄出：快递单号 */}
          {milestone.step_key === 'pre_production_sample_sent' && (
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                快递单号 <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                name="tracking_number"
                required
                placeholder="输入快递/物流单号"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white focus:outline-none focus:border-indigo-400"
              />
            </div>
          )}

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

          {/* AI 质检按钮 — QC节点显示 */}
          {showAiQc && (
            <div className="space-y-2">
              <button
                type="button"
                disabled={aiQcLoading}
                onClick={async () => {
                  if (!orderId) return;
                  setAiQcLoading(true);
                  setAiQcResult(null);
                  try {
                    const res = await detectDefectsForMilestone(orderId, milestone.id);
                    if (res.error) {
                      setSubmitError(`AI质检: ${res.error}`);
                    } else if (res.data) {
                      setAiQcResult(res.data);
                    }
                  } catch (e: any) {
                    setSubmitError(`AI质检失败: ${e?.message || '未知错误'}`);
                  }
                  setAiQcLoading(false);
                }}
                className="w-full rounded-lg bg-purple-600 px-4 py-2 text-sm text-white font-medium hover:bg-purple-700 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {aiQcLoading ? (
                  <><span className="animate-spin">⏳</span> AI 正在分析照片...</>
                ) : (
                  <><span>🔍</span> AI 智能质检（分析已上传照片）</>
                )}
              </button>

              {/* AI 质检结果 */}
              {aiQcResult && (
                <div className={`rounded-lg border p-3 space-y-2 ${
                  aiQcResult.overall === 'pass' ? 'bg-green-50 border-green-200' :
                  aiQcResult.overall === 'warning' ? 'bg-amber-50 border-amber-200' :
                  'bg-red-50 border-red-200'
                }`}>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold">
                      {aiQcResult.overall === 'pass' ? '✅ 质检通过' :
                       aiQcResult.overall === 'warning' ? '⚠️ 发现问题' :
                       '❌ 质检不通过'}
                    </span>
                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                      aiQcResult.quality_score >= 80 ? 'bg-green-100 text-green-700' :
                      aiQcResult.quality_score >= 60 ? 'bg-amber-100 text-amber-700' :
                      'bg-red-100 text-red-700'
                    }`}>
                      {aiQcResult.quality_score}/100
                    </span>
                  </div>
                  <p className="text-xs text-gray-600">{aiQcResult.summary}</p>

                  {aiQcResult.defects.length > 0 && (
                    <div className="space-y-1.5 mt-1">
                      {aiQcResult.defects.map((defect, i) => (
                        <div key={i} className={`text-xs rounded p-2 ${
                          defect.severity === 'critical' ? 'bg-red-100 border-l-2 border-red-500' :
                          defect.severity === 'major' ? 'bg-amber-100 border-l-2 border-amber-500' :
                          'bg-gray-100 border-l-2 border-gray-300'
                        }`}>
                          <div className="flex items-center gap-1 font-semibold">
                            <span>{defect.severity === 'critical' ? '🔴' : defect.severity === 'major' ? '🟡' : '⚪'}</span>
                            <span>{defect.type}</span>
                            <span className="text-gray-400">— {defect.location}</span>
                          </div>
                          <p className="text-gray-600 mt-0.5">{defect.description}</p>
                          <p className="text-indigo-600 mt-0.5">💡 {defect.suggestion}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

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

// ══════ 检查清单子组件 ══════

function ChecklistSection({ milestone, orderId, currentRoles, onResponsesChange }: {
  milestone: any;
  orderId: string;
  currentRoles: string[];
  onResponsesChange?: (responses: Record<string, { value: any; pending_date?: string }>) => void;
}) {
  const [config] = useState<ChecklistConfig | null>(() => getChecklistForStep(milestone.step_key));
  const [responses, setResponses] = useState<Record<string, { value: any; pending_date?: string }>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // 加载已有数据
  useEffect(() => {
    if (!config) return;
    const existing: ChecklistItemResponse[] = milestone.checklist_data || [];
    const map: Record<string, { value: any; pending_date?: string }> = {};
    for (const r of existing) {
      map[r.key] = { value: r.value, pending_date: r.pending_date };
    }
    setResponses(map);
  }, [config, milestone.checklist_data]);

  if (!config) return null;

  const handleChange = (key: string, value: any, pendingDate?: string) => {
    setResponses(prev => {
      const next = {
        ...prev,
        [key]: { value, pending_date: pendingDate || prev[key]?.pending_date },
      };
      onResponsesChange?.(next);
      return next;
    });
    setSaved(false);
  };

  // 初始化时也同步给父组件
  useEffect(() => {
    if (Object.keys(responses).length > 0) {
      onResponsesChange?.(responses);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = async () => {
    setSaving(true);
    // 只保存当前用户角色能编辑的字段
    const rolesLower = currentRoles.map(r => r.toLowerCase());
    const isAdmin = rolesLower.includes('admin');
    const data = Object.entries(responses)
      .filter(([key]) => {
        if (isAdmin) return true;
        const itemDef = config?.items.find(i => i.key === key);
        if (!itemDef) return true;
        const itemRole = itemDef.role.toLowerCase();
        return rolesLower.includes(itemRole)
          || (itemRole === 'sales' && rolesLower.includes('merchandiser'))
          || (itemRole === 'merchandiser' && rolesLower.includes('sales'))
          || (itemRole === 'admin_assistant' && rolesLower.includes('admin_assistant'));
      })
      .map(([key, r]) => ({
        key, value: r.value, pending_date: r.pending_date,
      }));
    if (data.length === 0) {
      alert('没有可保存的字段（当前角色只能编辑自己负责的项目）');
      setSaving(false);
      return;
    }
    const result = await saveChecklistData(milestone.id, data);
    if (result.error) {
      alert(result.error);
    } else {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
    setSaving(false);
  };

  // 按 group 分组
  const groups: { name: string; items: typeof config.items }[] = [];
  const seen = new Set<string>();
  for (const item of config.items) {
    const g = item.group || '其他';
    if (!seen.has(g)) {
      seen.add(g);
      groups.push({ name: g, items: [] });
    }
    groups.find(gr => gr.name === g)!.items.push(item);
  }

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-amber-900">📋 {config.title}</p>
        <button
          onClick={handleSave}
          disabled={saving}
          className="text-xs px-3 py-1 rounded-md bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50"
        >
          {saving ? '保存中...' : saved ? '✓ 已保存' : '保存清单'}
        </button>
      </div>

      {groups.map(group => (
        <div key={group.name}>
          <p className="text-xs font-medium text-amber-700 mb-1.5 mt-2">{group.name}</p>
          <div className="space-y-2">
            {group.items.map(item => {
              const val = responses[item.key];
              // 双签：如果 item 有 role 限制，且当前用户角色不匹配 → 禁用
              const rolesLower = currentRoles.map(r => r.toLowerCase());
              const itemRole = (item.role || '').toLowerCase();
              const canEdit = rolesLower.includes(itemRole)
                || rolesLower.includes('admin')
                || (itemRole === 'sales' && rolesLower.includes('merchandiser'))
                || (itemRole === 'merchandiser' && rolesLower.includes('sales'));
              const roleRestricted = !canEdit;
              const alreadyDone = !!val?.value; // 别人已经勾了
              return (
                <div key={item.key} className="flex items-start gap-2 bg-white rounded-md p-2 border border-amber-100">
                  {item.type === 'checkbox' && (
                    <label className={`flex items-center gap-2 flex-1 ${roleRestricted ? 'opacity-60' : 'cursor-pointer'}`}>
                      <input
                        type="checkbox"
                        checked={!!val?.value}
                        onChange={e => handleChange(item.key, e.target.checked)}
                        disabled={roleRestricted && !alreadyDone}
                        className="w-4 h-4 rounded border-gray-300 text-amber-600 disabled:opacity-50"
                      />
                      <span className="text-sm text-gray-700">{item.label}</span>
                      {item.required && <span className="text-red-500 text-xs">*</span>}
                      {roleRestricted && !alreadyDone && (
                        <span className="text-xs text-gray-400 ml-1">（等待{
                          item.role === 'admin' ? 'CEO' :
                          item.role === 'admin_assistant' ? '行政督察' :
                          item.role === 'sales' ? '业务' :
                          item.role === 'merchandiser' ? '跟单' :
                          item.role
                        }确认）</span>
                      )}
                      {alreadyDone && roleRestricted && (
                        <span className="text-xs text-green-600 ml-1">✓ 已确认</span>
                      )}
                    </label>
                  )}

                  {item.type === 'select' && (
                    <div className="flex-1">
                      <label className="text-sm text-gray-700 mb-1 block">
                        {item.label} {item.required && <span className="text-red-500">*</span>}
                      </label>
                      <select
                        value={String(val?.value || '')}
                        onChange={e => handleChange(item.key, e.target.value)}
                        className="w-full rounded border border-gray-300 px-2 py-1 text-sm"
                      >
                        <option value="">请选择</option>
                        {(item.options || []).map(opt => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  {item.type === 'text' && (
                    <div className="flex-1">
                      <label className="text-sm text-gray-700 mb-1 block">
                        {item.label} {item.required && <span className="text-red-500">*</span>}
                      </label>
                      <input
                        type="text"
                        value={String(val?.value || '')}
                        onChange={e => handleChange(item.key, e.target.value)}
                        placeholder={item.helpText || ''}
                        className="w-full rounded border border-gray-300 px-2 py-1 text-sm"
                      />
                    </div>
                  )}

                  {item.type === 'number' && (
                    <div className="flex-1">
                      <label className="text-sm text-gray-700 mb-1 block">
                        {item.label} {item.required && <span className="text-red-500">*</span>}
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        value={val?.value !== null && val?.value !== undefined ? String(val.value) : ''}
                        onChange={e => handleChange(item.key, e.target.value ? parseFloat(e.target.value) : null)}
                        placeholder={item.helpText || ''}
                        className="w-full rounded border border-gray-300 px-2 py-1 text-sm"
                      />
                    </div>
                  )}

                  {item.type === 'pending_date' && (
                    <div className="flex-1">
                      <label className="text-sm text-gray-700 mb-1 block">
                        {item.label}
                        {item.affectsSchedule && <span className="text-orange-500 text-xs ml-1">影响排期</span>}
                      </label>
                      <input
                        type="date"
                        value={val?.pending_date || ''}
                        onChange={e => handleChange(item.key, e.target.value ? true : null, e.target.value)}
                        className="w-full rounded border border-gray-300 px-2 py-1 text-sm"
                      />
                      {item.helpText && <p className="text-xs text-gray-400 mt-0.5">{item.helpText}</p>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ══════ 已完成节点补传文件 ══════

function CompletedFileUpload({ milestoneId, orderId, stepKey, isProductionUpload }: {
  milestoneId: string; orderId: string; stepKey: string; isProductionUpload: boolean;
}) {
  const [uploading, setUploading] = useState(false);
  const [files, setFiles] = useState<Array<{ id: string; file_name: string; file_url: string; file_type: string; created_at: string }>>([]);
  const [showUpload, setShowUpload] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    (supabase.from('order_attachments') as any)
      .select('id, file_name, file_url, file_type, created_at')
      .eq('order_id', orderId)
      .eq('milestone_id', milestoneId)
      .order('created_at', { ascending: false })
      .then(({ data }: any) => setFiles(data || []));
  }, [milestoneId, orderId]);

  async function handleUpload(file: File, fileType: string) {
    setUploading(true);
    const supabase = createClient();
    const ext = file.name.split('.').pop() || 'bin';
    const path = `${orderId}/milestones/${stepKey}_${fileType}_${Date.now()}.${ext}`;
    const { error: uploadErr } = await supabase.storage.from('order-docs').upload(path, file, { contentType: file.type, upsert: true });
    if (uploadErr) { alert('上传失败: ' + uploadErr.message); setUploading(false); return; }
    const { data: urlData } = supabase.storage.from('order-docs').getPublicUrl(path);
    const { data: { user } } = await supabase.auth.getUser();
    await (supabase.from('order_attachments') as any).insert({
      order_id: orderId, milestone_id: milestoneId,
      uploaded_by: user?.id || null,
      file_name: file.name, file_url: urlData?.publicUrl || path,
      file_type: fileType, mime_type: file.type || null,
    });
    const { data } = await (supabase.from('order_attachments') as any)
      .select('id, file_name, file_url, file_type, created_at')
      .eq('order_id', orderId).eq('milestone_id', milestoneId).order('created_at', { ascending: false });
    setFiles(data || []);
    setUploading(false);
  }

  const typeLabels: Record<string, string> = {
    production_order: '生产订单', packing_requirement: '包装资料', evidence: '凭证', trims_sheet: '辅料表',
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-gray-600">
          {files.length > 0 ? `已上传 ${files.length} 个文件` : '补传文件'}
        </span>
        <button onClick={() => setShowUpload(!showUpload)} className="text-xs text-indigo-600 hover:underline">
          {showUpload ? '收起' : '+ 上传文件'}
        </button>
      </div>
      {files.length > 0 && (
        <div className="space-y-1 mb-2">
          {files.map(f => (
            <div key={f.id} className="flex items-center justify-between text-xs bg-white rounded px-2 py-1.5 border border-gray-100">
              <span className="truncate text-gray-700">📎 {f.file_name || '文件'} <span className="text-gray-400">({typeLabels[f.file_type] || f.file_type})</span></span>
              <span className="flex items-center gap-2 shrink-0 ml-2">
                {f.file_url && <a href={f.file_url} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline">查看</a>}
                <button
                  type="button"
                  onClick={async () => {
                    if (!confirm(`确定删除「${f.file_name}」？此操作不可恢复。`)) return;
                    const { deleteAttachment } = await import('@/app/actions/attachments');
                    const res = await deleteAttachment(f.id, orderId);
                    if (res.error) { alert(res.error); return; }
                    setFiles(prev => prev.filter(x => x.id !== f.id));
                  }}
                  className="text-red-500 hover:text-red-700"
                  title="删除"
                >
                  删除
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
      {showUpload && (
        <div className="space-y-2">
          {isProductionUpload ? (
            <>
              <div className="grid grid-cols-3 gap-2">
                <label className="text-center py-2.5 rounded-lg border-2 border-dashed border-indigo-300 text-xs text-indigo-600 cursor-pointer hover:bg-indigo-50">
                  📄 生产订单
                  <input type="file" className="hidden" disabled={uploading} accept=".pdf,.xlsx,.xls,.doc,.docx,.jpg,.jpeg,.png"
                    onChange={e => { if (e.target.files?.[0]) handleUpload(e.target.files[0], 'production_order'); e.target.value = ''; }} />
                </label>
                <label className="text-center py-2.5 rounded-lg border-2 border-dashed border-green-300 text-xs text-green-600 cursor-pointer hover:bg-green-50">
                  🧵 原辅料单
                  <input type="file" className="hidden" disabled={uploading} accept=".pdf,.xlsx,.xls,.doc,.docx,.jpg,.jpeg,.png"
                    onChange={e => { if (e.target.files?.[0]) handleUpload(e.target.files[0], 'trims_sheet'); e.target.value = ''; }} />
                </label>
                <label className="text-center py-2.5 rounded-lg border-2 border-dashed border-amber-300 text-xs text-amber-600 cursor-pointer hover:bg-amber-50">
                  📦 包装资料
                  <input type="file" className="hidden" disabled={uploading} accept=".pdf,.xlsx,.xls,.doc,.docx,.jpg,.jpeg,.png"
                    onChange={e => { if (e.target.files?.[0]) handleUpload(e.target.files[0], 'packing_requirement'); e.target.value = ''; }} />
                </label>
              </div>
              <p className="text-xs text-gray-400">文件将同步显示在「原辅料和包装」tab</p>
            </>
          ) : (
            <label className="block text-center py-2 rounded-lg border-2 border-dashed border-gray-300 text-xs text-gray-500 cursor-pointer hover:bg-gray-100">
              📎 上传凭证文件
              <input type="file" className="hidden" disabled={uploading} accept=".pdf,.xlsx,.xls,.doc,.docx,.jpg,.jpeg,.png"
                onChange={e => { if (e.target.files?.[0]) handleUpload(e.target.files[0], 'evidence'); e.target.value = ''; }} />
            </label>
          )}
          {uploading && <p className="text-xs text-indigo-500 text-center">上传中...</p>}
        </div>
      )}
    </div>
  );
}

// ══════ 补传文件组件（节点完成后仍可上传） ══════

function SupplementaryUpload({ milestoneId, orderId, stepKey }: { milestoneId: string; orderId: string; stepKey: string }) {
  const [files, setFiles] = useState<any[]>([]);
  const [uploading, setUploading] = useState(false);
  const router = useRouter();

  useEffect(() => {
    loadFiles();
  }, [milestoneId]);

  async function loadFiles() {
    const supabase = createClient();
    const { data } = await (supabase.from('order_attachments') as any)
      .select('id, file_name, file_url, file_type, created_at')
      .eq('order_id', orderId)
      .eq('milestone_id', milestoneId)
      .order('created_at', { ascending: false });
    setFiles(data || []);
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const supabase = createClient();
    const ext = file.name.split('.').pop() || 'bin';
    const path = `${orderId}/milestones/${stepKey}_supplement_${Date.now()}.${ext}`;
    const { error: uploadErr } = await supabase.storage.from('order-docs').upload(path, file, { contentType: file.type, upsert: true });
    if (uploadErr) { alert('上传失败: ' + uploadErr.message); setUploading(false); return; }
    const { data: urlData } = supabase.storage.from('order-docs').getPublicUrl(path);
    const { data: { user } } = await supabase.auth.getUser();
    await (supabase.from('order_attachments') as any).insert({
      order_id: orderId, milestone_id: milestoneId,
      uploaded_by: user?.id || null,
      file_name: file.name, file_url: urlData?.publicUrl || path,
      storage_path: path,
      file_type: 'production_order', mime_type: file.type || null,
    });
    await loadFiles();
    setUploading(false);
    router.refresh();
  }

  return (
    <div className="space-y-2">
      {files.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-gray-600">已上传 {files.length} 个文件：</p>
          {files.map(f => (
            <div key={f.id} className="flex items-center justify-between text-xs bg-white rounded px-2 py-1.5 border border-gray-100">
              <a href={f.file_url} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline truncate">{f.file_name}</a>
              <span className="text-gray-400 shrink-0 ml-2">{new Date(f.created_at).toLocaleDateString('zh-CN')}</span>
            </div>
          ))}
        </div>
      )}
      <label className="flex items-center justify-center gap-2 py-2 px-4 rounded-lg border-2 border-dashed border-indigo-300 text-sm text-indigo-600 hover:bg-indigo-50 cursor-pointer">
        {uploading ? '上传中...' : '+ 补传文件'}
        <input type="file" className="hidden" onChange={handleUpload} accept=".pdf,.xlsx,.xls,.doc,.docx,.jpg,.jpeg,.png" disabled={uploading} />
      </label>
    </div>
  );
}
