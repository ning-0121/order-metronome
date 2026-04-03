'use client';
import { useState, useEffect, useRef } from 'react';
import { markMilestoneDone, markMilestoneBlocked, saveChecklistData } from '@/app/actions/milestones';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { isDoneStatus, isActiveStatus, isPendingStatus } from '@/lib/domain/types';
import { AIAdviceBox } from '@/components/AIAdviceBox';
import { getChecklistForStep, type ChecklistConfig, type ChecklistItemResponse } from '@/lib/domain/checklist';

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
  const [evidenceNote, setEvidenceNote] = useState('');
  const [blockError, setBlockError] = useState('');
  const [submitError, setSubmitError] = useState('');
  // 检查清单响应数据的引用，供提交时自动保存
  const checklistResponsesRef = useRef<Record<string, { value: any; pending_date?: string }> | null>(null);

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
        // 写入 attachments 表（markMilestoneDone 会检查此表）
        const { data: { publicUrl } } = supabase.storage.from('order-docs').getPublicUrl(path);
        const { data: { user } } = await supabase.auth.getUser();
        const { error: attachError } = await (supabase.from('attachments') as any).insert({
          milestone_id: milestone.id,
          order_id: orderId,
          url: publicUrl,
          file_name: evidenceFile.name,
          file_type: evidenceFile.type || ext,
          uploaded_by: user?.id || null,
        });
        if (attachError) {
          // RLS可能阻止插入，尝试用 order_attachments 表
          await (supabase.from('order_attachments') as any).insert({
            order_id: orderId,
            milestone_id: milestone.id,
            uploaded_by: user?.id || null,
            file_name: evidenceFile.name,
            file_url: publicUrl,
            mime_type: evidenceFile.type || null,
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

      // 收集检查清单数据，连同标记完成一起发给服务端
      let checklistPayload: Array<{ key: string; value: any; pending_date?: string }> | null = null;
      if (checklistResponsesRef.current && Object.keys(checklistResponsesRef.current).length > 0) {
        checklistPayload = Object.entries(checklistResponsesRef.current).map(([key, r]) => {
          const item: { key: string; value: any; pending_date?: string } = { key, value: r.value ?? null };
          if (r.pending_date) item.pending_date = r.pending_date;
          return item;
        });
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

  // ── 已完成状态 ─────────────────────────────────────────────────
  if (isDoneStatus(milestone.status)) {
    return (
      <div className="flex items-center gap-2 text-green-700 text-sm font-medium bg-green-50 px-3 py-2 rounded-lg">
        <span>✓</span>
        <span>已完成</span>
      </div>
    );
  }

  // 「进行中」or「pending 但已逾期」or「pending 但有操作权限的用户」都可操作
  const isInProgress = isActiveStatus(milestone.status);
  const isPending = isPendingStatus(milestone.status);
  const isPendingOverdue = isPending && milestone.due_at && new Date(milestone.due_at) < new Date();
  const isActive = isInProgress || (isPending && canModify);
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
      {showSubmitForm && canModify && !isBlocked && (
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

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              {(() => {
                const labels: Record<string, string> = {
                  mid_qc_check: '上传中查报告',
                  final_qc_check: '上传尾查报告',
                  inspection_release: '上传验货报告 / 放行单',
                  po_confirmed: '上传客户PO',
                  production_order_upload: '上传生产单',
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
              onChange={e => setEvidenceFile(e.target.files?.[0] || null)}
              className="block w-full text-sm text-gray-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-white file:text-indigo-700 hover:file:bg-indigo-50 cursor-pointer"
            />
            <p className="text-xs text-gray-400 mt-1">支持 PDF、图片、Excel、Word</p>
          </div>

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
    const data = Object.entries(responses).map(([key, r]) => ({
      key, value: r.value, pending_date: r.pending_date,
    }));
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
              return (
                <div key={item.key} className="flex items-start gap-2 bg-white rounded-md p-2 border border-amber-100">
                  {item.type === 'checkbox' && (
                    <label className="flex items-center gap-2 cursor-pointer flex-1">
                      <input
                        type="checkbox"
                        checked={!!val?.value}
                        onChange={e => handleChange(item.key, e.target.checked)}
                        className="w-4 h-4 rounded border-gray-300 text-amber-600"
                      />
                      <span className="text-sm text-gray-700">{item.label}</span>
                      {item.required && <span className="text-red-500 text-xs">*</span>}
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
