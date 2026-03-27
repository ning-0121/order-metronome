'use client';
import { formatDate, isOverdue } from '@/lib/utils/date';
import { MilestoneActions } from './MilestoneActions';
import { DelayRequestForm } from './DelayRequestForm';
import { EvidenceUpload } from './EvidenceUpload';
import { OwnerAssignment } from './OwnerAssignment';
import { SOPButton } from './SOPModal';
import { getSOPForStep } from '@/lib/domain/sop';
import { getMilestoneLogs } from '@/app/actions/milestones';
import { useState, useEffect } from 'react';
import type { Milestone } from '@/lib/types';
import { getRoleLabel } from '@/lib/utils/i18n';
import { computeDeliveryAlert, computeDelayDays } from '@/lib/domain/milestone-helpers';
import { updateMilestoneActualDate } from '@/app/actions/milestones';

/** 允许填写实际日期的节点 */
const ACTUAL_DATE_EDITABLE_KEYS = [
  'materials_received_inspected',
  'production_kickoff',
  'factory_completion',
];

interface OrderTimelineProps {
  milestones: Milestone[];
  orderId: string;
  orderIncoterm: 'FOB' | 'DDP';
  currentRole?: string;
  currentRoles?: string[];
  isAdmin?: boolean;
}

// V1 最终分组（对齐新节点表）
const MILESTONE_GROUPS = [
  {
    key: 'stage1', emoji: '🟦',
    titleCn: '阶段 1：订单启动',
    stepKeys: ['po_confirmed', 'finance_approval', 'production_order_upload'],
  },
  {
    key: 'stage2', emoji: '🟨',
    titleCn: '阶段 2：订单转化',
    stepKeys: ['order_docs_bom_complete', 'bulk_materials_confirmed'],
  },
  {
    key: 'stage3', emoji: '🟧',
    titleCn: '阶段 3：工厂选定 & 产前样',
    stepKeys: ['processing_fee_confirmed', 'factory_confirmed', 'pre_production_sample_ready', 'pre_production_sample_sent', 'pre_production_sample_approved'],
  },
  {
    key: 'stage4', emoji: '🟩',
    titleCn: '阶段 4：采购与生产',
    stepKeys: ['procurement_order_placed', 'materials_received_inspected', 'production_kickoff', 'pre_production_meeting'],
  },
  {
    key: 'stage5', emoji: '🟪',
    titleCn: '阶段 5：过程控制',
    stepKeys: ['mid_qc_check', 'final_qc_check'],
  },
  {
    key: 'stage6', emoji: '🟥',
    titleCn: '阶段 6：出货控制',
    stepKeys: ['packing_method_confirmed', 'factory_completion', 'inspection_release', 'shipping_sample_send'],
  },
  {
    key: 'stage7', emoji: '🟫',
    titleCn: '阶段 7：物流收款',
    stepKeys: ['booking_done', 'customs_export', 'payment_received'],
  },
];

// 统一状态判断：兼容中英文
const _isDone = (s: string) => s === 'done' || s === '已完成' || s === 'completed';
const _isActive = (s: string) => s === 'in_progress' || s === '进行中';
const _isPending = (s: string) => s === 'pending' || s === '未开始';
const _isBlocked = (s: string) => s === 'blocked' || s === '卡单' || s === '卡住';
const _statusLabel = (s: string) => _isDone(s) ? '已完成' : _isActive(s) ? '进行中' : _isBlocked(s) ? '卡住' : '未开始';

const STATUS_STYLE: Record<string, string> = {
  '未开始': 'bg-gray-100 text-gray-600',
  'pending': 'bg-gray-100 text-gray-600',
  '进行中': 'bg-blue-100 text-blue-700',
  'in_progress': 'bg-blue-100 text-blue-700',
  '已完成': 'bg-green-100 text-green-700',
  'done': 'bg-green-100 text-green-700',
  '卡单':   'bg-orange-100 text-orange-700',
  '卡住':   'bg-orange-100 text-orange-700',
  'blocked': 'bg-orange-100 text-orange-700',
};

/** 实际/预计日期输入组件 */
function ActualDateInput({ milestoneId, currentActualAt, dueAt }: {
  milestoneId: string;
  currentActualAt: string | null;
  dueAt: string | null;
}) {
  const [value, setValue] = useState(currentActualAt ? currentActualAt.substring(0, 10) : '');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  const alert = computeDeliveryAlert(value || null, dueAt);
  const alertColor = alert === 'RED' ? 'border-red-300 bg-red-50' :
    alert === 'YELLOW' ? 'border-yellow-300 bg-yellow-50' :
    value ? 'border-green-300 bg-green-50' : 'border-gray-200 bg-white';

  async function handleSave() {
    setSaving(true);
    setMsg('');
    const result = await updateMilestoneActualDate(milestoneId, value ? value + 'T00:00:00Z' : null);
    setSaving(false);
    if (result.error) {
      setMsg(result.error);
    } else {
      setMsg(value ? '已保存' : '已清除');
      setTimeout(() => setMsg(''), 2000);
    }
  }

  return (
    <div className={`rounded-lg border p-3 ${alertColor}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex-1">
          <label className="text-xs font-semibold text-gray-700 block mb-1">
            📅 实际/预计完成日期
            {dueAt && <span className="text-gray-400 font-normal ml-2">（系统截止：{formatDate(dueAt)}）</span>}
          </label>
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={value}
              onChange={e => setValue(e.target.value)}
              className="text-sm border border-gray-300 rounded-md px-2 py-1 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            />
            <button
              onClick={handleSave}
              disabled={saving}
              className="text-xs px-3 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving ? '保存中...' : '保存'}
            </button>
            {value && (
              <button
                onClick={() => { setValue(''); }}
                className="text-xs px-2 py-1.5 rounded-md text-gray-500 hover:text-red-600 hover:bg-red-50"
              >
                清除
              </button>
            )}
          </div>
        </div>
        {alert !== 'GREEN' && (
          <div className={`text-xs font-semibold px-2 py-1 rounded ${
            alert === 'RED' ? 'text-red-700' : 'text-yellow-700'
          }`}>
            {alert === 'RED' ? '🚨 交期风险' : '⚠ 进度偏差'}
          </div>
        )}
      </div>
      {msg && <p className={`text-xs mt-1 ${msg.includes('失败') || msg.includes('error') ? 'text-red-600' : 'text-green-600'}`}>{msg}</p>}
    </div>
  );
}

export function OrderTimeline({ milestones, orderId, orderIncoterm, currentRole, currentRoles = [], isAdmin = false }: OrderTimelineProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, any[]>>({});

  useEffect(() => {
    if (expandedId) {
      getMilestoneLogs(expandedId).then(r => {
        if (r.data) setLogs(prev => ({ ...prev, [expandedId]: r.data }));
      });
    }
  }, [expandedId]);

  // 按 sequence_number 全局排序（兼容旧数据用 due_at 兜底）
  const sorted = [...milestones].sort((a, b) => {
    const aN = (a as any).sequence_number ?? 99;
    const bN = (b as any).sequence_number ?? 99;
    if (aN !== bN) return aN - bN;
    if (!a.due_at || !b.due_at) return 0;
    return new Date(a.due_at).getTime() - new Date(b.due_at).getTime();
  });

  const grouped = MILESTONE_GROUPS.map(g => ({
    ...g,
    items: sorted.filter(m => g.stepKeys.includes((m as any).step_key)),
  }));

  return (
    <div className="space-y-6">
      {grouped.map(group => {
        // 跳过没有节点的分组（如 shipping_sample_send 被过滤掉时）
        if (group.items.length === 0) return null;

        // 分组进度统计
        const done = group.items.filter(m => _isDone(m.status)).length;
        const total = group.items.length;
        const pct = total > 0 ? Math.round(done / total * 100) : 0;

        return (
          <div key={group.key} className="rounded-xl border border-gray-200 bg-white overflow-hidden">
            {/* 分组标题 */}
            <div className="flex items-center justify-between px-5 py-3 bg-gray-50 border-b border-gray-200">
              <h3 className="font-semibold text-gray-900 text-sm">
                {group.emoji} {group.titleCn}
              </h3>
              <div className="flex items-center gap-3">
                <span className="text-xs text-gray-500">{done}/{total}</span>
                <div className="w-20 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className={'h-full rounded-full ' + (pct === 100 ? 'bg-green-500' : 'bg-indigo-500')}
                    style={{ width: pct + '%' }}
                  />
                </div>
              </div>
            </div>

            {/* 节点列表 */}
            <div className="divide-y divide-gray-100">
              {group.items.map(milestone => {
                const m = milestone as any;
                const overdue = m.due_at ? isOverdue(m.due_at) : false;
                const isActive = _isActive(m.status);
                const isDone = _isDone(m.status);
                const isBlocked = _isBlocked(m.status);
                const isExpanded = expandedId === m.id;

                // 前置阻断检查（显示用）
                const blockedBy = sorted.filter(other => {
                  const otherBlocks: string[] = (other as any).blocks || [];
                  const otherDone = _isDone(other.status);
                  return otherBlocks.includes(m.step_key) && !otherDone;
                }).map(o => (o as any).name || (o as any).step_key);

                const isHardBlocked = blockedBy.length > 0 && !isDone;

                return (
                  <div key={m.id}
                    className={'px-5 py-4 ' + (
                      isDone ? 'bg-green-50/30' :
                      isBlocked ? 'bg-orange-50' :
                      isHardBlocked ? 'bg-red-50/30' :
                      isActive ? 'bg-blue-50/20' : ''
                    )}
                  >
                    <div className="flex items-start justify-between gap-4">
                      {/* 左侧：节点信息 */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-2">
                          {/* 状态圆点 */}
                          <span className={'inline-block w-2 h-2 rounded-full flex-shrink-0 ' + (
                            isDone ? 'bg-green-500' :
                            isBlocked ? 'bg-orange-500' :
                            isActive ? 'bg-blue-500 animate-pulse' :
                            'bg-gray-300'
                          )} />
                          <span className={'font-medium text-sm ' + (isDone ? 'text-gray-500 line-through' : 'text-gray-900')}>
                            {m.name}
                          </span>
                          <span className={'text-xs px-2 py-0.5 rounded-full font-medium ' + (STATUS_STYLE[m.status] || STATUS_STYLE['未开始'])}>
                            {_statusLabel(m.status)}
                          </span>
                          {m.is_critical && !isDone && (
                            <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">关键</span>
                          )}
                          {overdue && isActive && (() => {
                            const ownerRole = (m.owner_role || '').toLowerCase();
                            const allUserRoles = currentRoles.length > 0 ? currentRoles : (currentRole ? [currentRole] : []);
                            const isMineOverdue = isAdmin || allUserRoles.some(r => {
                              const nr = r.toLowerCase();
                              return nr === ownerRole
                                || (ownerRole === 'qc' && (nr === 'quality' || nr === 'qc'))
                                || (ownerRole === 'quality' && (nr === 'qc' || nr === 'quality'))
                                || (ownerRole === 'sales' && nr === 'merchandiser')
                                || (ownerRole === 'merchandiser' && nr === 'sales');
                            });
                            const roleName = getRoleLabel(m.owner_role);
                            return isMineOverdue
                              ? <span className="text-xs px-2 py-0.5 rounded-full bg-red-600 text-white font-medium">🔴 我的逾期</span>
                              : <span className="text-xs px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 font-medium">⚠ {roleName}逾期</span>;
                          })()}
                          {/* 交期预警徽章 */}
                          {(() => {
                            const alert = computeDeliveryAlert(m.actual_at, m.due_at);
                            if (alert === 'RED') {
                              const days = computeDelayDays(m.actual_at, m.due_at);
                              return <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">🚨 交期风险 +{days}天</span>;
                            }
                            if (alert === 'YELLOW') {
                              const days = computeDelayDays(m.actual_at, m.due_at);
                              return <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-700 font-medium">⚠ 进度偏差 +{days}天</span>;
                            }
                            return null;
                          })()}
                          {/* SOP 按钮 */}
                          {(() => {
                            const sop = getSOPForStep(m.step_key);
                            return sop ? <SOPButton stepKey={m.step_key} milestoneName={m.name} sop={sop} /> : null;
                          })()}
                        </div>

                        {/* 元信息行 */}
                        <div className="flex flex-wrap gap-x-3 md:gap-x-4 gap-y-1 text-[11px] md:text-xs text-gray-500">
                          <span>责任人：{getRoleLabel(m.owner_role)}</span>
                          {m.deadline_hint && <span>时限：{m.deadline_hint}</span>}
                          {m.due_at && (() => {
                            if (!overdue || !isActive) return <span>截止：{formatDate(m.due_at)}</span>;
                            const ownerRole = (m.owner_role || '').toLowerCase();
                            const allUserRoles = currentRoles.length > 0 ? currentRoles : (currentRole ? [currentRole] : []);
                            const isMineOverdue = isAdmin || allUserRoles.some(r => {
                              const nr = r.toLowerCase();
                              return nr === ownerRole
                                || (ownerRole === 'qc' && (nr === 'quality' || nr === 'qc'))
                                || (ownerRole === 'quality' && (nr === 'qc' || nr === 'quality'))
                                || (ownerRole === 'sales' && nr === 'merchandiser')
                                || (ownerRole === 'merchandiser' && nr === 'sales');
                            });
                            return (
                              <span className={isMineOverdue ? 'text-red-600 font-semibold' : 'text-orange-500 font-medium'}>
                                截止：{formatDate(m.due_at)}
                              </span>
                            );
                          })()}
                          {m.actual_at && (
                            <span className={
                              computeDeliveryAlert(m.actual_at, m.due_at) === 'RED' ? 'text-red-600 font-semibold' :
                              computeDeliveryAlert(m.actual_at, m.due_at) === 'YELLOW' ? 'text-yellow-600 font-semibold' :
                              'text-green-600'
                            }>
                              实际：{formatDate(m.actual_at)}
                            </span>
                          )}
                        </div>

                        {/* evidence_note 提示（进行中且未展开时显示） */}
                        {isActive && m.evidence_note && !isExpanded && (
                          <div className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                            <span className="flex-shrink-0">📋</span>
                            <span>{m.evidence_note}</span>
                          </div>
                        )}

                        {/* 硬阻断提示 */}
                        {isHardBlocked && !isDone && (
                          <div className="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                            ⛔ 前置控制点未完成：{blockedBy.join('、')}
                          </div>
                        )}

                        {/* 阻塞说明 */}
                        {isBlocked && m.notes && (
                          <div className="mt-2 text-xs text-orange-700 bg-orange-100 rounded-lg px-3 py-2">
                            🚧 阻塞说明：{m.notes.startsWith('卡单原因：') ? m.notes.substring(5) : m.notes}
                          </div>
                        )}
                      </div>

                      {/* 右侧：展开按钮 */}
                      <button
                        onClick={() => setExpandedId(isExpanded ? null : m.id)}
                        className="flex-shrink-0 text-xs text-indigo-600 hover:text-indigo-700 font-medium px-3 py-1.5 rounded-lg hover:bg-indigo-50"
                      >
                        {isExpanded ? '收起' : '处理 →'}
                      </button>
                    </div>

                    {/* 展开区 */}
                    {isExpanded && (
                      <div className="mt-4 pt-4 border-t border-gray-200 space-y-4">
                        {/* 实际/预计日期输入（仅关键生产节点） */}
                        {ACTUAL_DATE_EDITABLE_KEYS.includes(m.step_key) && !_isDone(m.status) && (
                          <ActualDateInput
                            milestoneId={m.id}
                            currentActualAt={m.actual_at}
                            dueAt={m.due_at}
                          />
                        )}

                        <OwnerAssignment
                          milestoneId={m.id}
                          currentOwnerUserId={m.owner_user_id}
                          isAdmin={isAdmin}
                        />

                        {/* evidence_note 完整提示 */}
                        {m.evidence_note && (
                          <div className="rounded-lg bg-amber-50 border border-amber-200 p-3">
                            <p className="text-xs font-semibold text-amber-800 mb-1">📋 需要提交的凭证：</p>
                            <p className="text-xs text-amber-700">{m.evidence_note}</p>
                          </div>
                        )}

                        {/* SOP 操作规程（展开时显示完整内容） */}
                        {(() => {
                          const sop = getSOPForStep(m.step_key);
                          if (!sop) return null;
                          return (
                            <div className="rounded-lg bg-indigo-50 border border-indigo-200 p-4">
                              <h4 className="text-xs font-semibold text-indigo-800 mb-2">📖 {sop.sop_title}</h4>
                              <div className="space-y-1.5 text-xs text-indigo-700">
                                {sop.sop_steps.map((step, i) => (
                                  <p key={i}>{step}</p>
                                ))}
                              </div>
                              <div className="mt-3 pt-2 border-t border-indigo-200">
                                <p className="text-xs font-semibold text-indigo-800 mb-1">完成标准：</p>
                                <ul className="space-y-0.5">
                                  {sop.completion_rules.map((rule, i) => (
                                    <li key={i} className="text-xs text-indigo-600">☑ {rule}</li>
                                  ))}
                                </ul>
                              </div>
                            </div>
                          );
                        })()}

                        {/* 核心操作区：MilestoneActions（去处理 + 申请延期） */}
                        <MilestoneActions
                          milestone={m}
                          allMilestones={sorted}
                          currentRole={currentRole}
                          currentRoles={currentRoles}
                          isAdmin={isAdmin}
                          orderId={orderId}
                        />

                        <EvidenceUpload
                          milestoneId={m.id}
                          orderId={orderId}
                          evidenceRequired={m.evidence_required || false}
                        />

                        {!_isDone(m.status) &&
                          (isAdmin || (currentRoles.length > 0 ? currentRoles : (currentRole ? [currentRole] : [])).some(r => {
                            const nr = r.toLowerCase(); const or2 = (m.owner_role || '').toLowerCase();
                            return nr === or2 || (or2 === 'qc' && nr === 'quality') || (or2 === 'sales' && nr === 'merchandiser');
                          })) && (
                          <div className="bg-gray-50 rounded-lg p-4">
                            <h4 className="text-xs font-semibold text-gray-600 uppercase mb-2">申请顺延</h4>
                            <DelayRequestForm
                              milestoneId={m.id}
                              milestone={m}
                              orderIncoterm={orderIncoterm}
                              milestoneDueAt={m.due_at || null}
                            />
                          </div>
                        )}

                        {/* 执行记录 */}
                        <div className="bg-gray-50 rounded-lg p-4">
                          <h4 className="text-xs font-semibold text-gray-600 uppercase mb-2">执行记录</h4>
                          {(logs[m.id] || []).length > 0 ? (
                            <div className="space-y-2">
                              {(logs[m.id] || []).map((log: any) => (
                                <div key={log.id} className="text-xs border-l-2 border-indigo-200 pl-3 py-1">
                                  <p className="font-medium text-gray-900">{log.action}</p>
                                  {log.note && <p className="text-gray-600 mt-0.5">{log.note}</p>}
                                  <p className="text-gray-400 mt-0.5">{formatDate(log.created_at)}</p>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="text-xs text-gray-400">暂无执行记录</p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
