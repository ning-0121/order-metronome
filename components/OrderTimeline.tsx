'use client';
import { formatDate, formatDateTime, formatRelative, isOverdue } from '@/lib/utils/date';
import { isDoneStatus, isActiveStatus, isPendingStatus, isBlockedStatus, normalizeMilestoneStatus } from '@/lib/domain/types';
import { MilestoneActions } from './MilestoneActions';
import { DelayRequestForm } from './DelayRequestForm';
import { OwnerAssignment } from './OwnerAssignment';
import { SOPButton } from './SOPModal';
import { getSOPForStep } from '@/lib/domain/sop';
import { getMilestoneLogs } from '@/app/actions/milestones';
import { useState, useEffect, useRef, useMemo } from 'react';
import type { Milestone } from '@/lib/types';
import { getRoleLabel } from '@/lib/utils/i18n';
import { POParserModal } from './POParserModal';
import { computeDeliveryAlert, computeDelayDays } from '@/lib/domain/milestone-helpers';
import { updateMilestoneActualDate } from '@/app/actions/milestones';
import { getSwimLane, getDefaultLanesForRoles, LANE_META, type SwimLane } from '@/lib/domain/swimLane';

/** 允许填写实际日期的节点 */
const ACTUAL_DATE_EDITABLE_KEYS = [
  'materials_received_inspected',
  'production_kickoff',
  'factory_completion',
];

interface OrderTimelineProps {
  milestones: Milestone[];
  orderId: string;
  orderNo?: string;
  orderIncoterm: 'FOB' | 'DDP';
  currentRole?: string;
  currentRoles?: string[];
  currentUserId?: string;
  isAdmin?: boolean;
}

// V1 最终分组（对齐新节点表）
const MILESTONE_GROUPS = [
  {
    key: 'stage1', emoji: '🟦',
    titleCn: '阶段 1：订单评审',
    stepKeys: ['po_confirmed', 'finance_approval', 'order_kickoff_meeting', 'production_order_upload'],
  },
  {
    key: 'stage2', emoji: '🟨',
    titleCn: '阶段 2：预评估',
    stepKeys: ['order_docs_bom_complete', 'bulk_materials_confirmed'],
  },
  {
    key: 'stage3', emoji: '🟧',
    titleCn: '阶段 3：工厂匹配 & 产前样',
    stepKeys: ['processing_fee_confirmed', 'factory_confirmed', 'pre_production_sample_ready', 'pre_production_sample_sent', 'pre_production_sample_approved'],
  },
  {
    key: 'stage4', emoji: '🟩',
    titleCn: '阶段 4：采购与生产准备',
    // 顺序修复（2026-04-08）：产前会必须在原料到货后、开裁前
    stepKeys: ['procurement_order_placed', 'materials_received_inspected', 'pre_production_meeting', 'production_kickoff'],
  },
  {
    key: 'stage5', emoji: '🟪',
    titleCn: '阶段 5：过程控制（跟单+业务双重验货）',
    // 补全（2026-04-08）：之前漏了 mid_qc_sales_check / final_qc_sales_check
    stepKeys: ['mid_qc_check', 'mid_qc_sales_check', 'final_qc_check', 'final_qc_sales_check'],
  },
  {
    key: 'stage6', emoji: '🟥',
    titleCn: '阶段 6：出货控制',
    // 顺序修复（2026-04-08）：船样寄送必须在包装确认后、工厂完成前
    stepKeys: ['packing_method_confirmed', 'shipping_sample_send', 'factory_completion', 'leftover_collection', 'finished_goods_warehouse', 'inspection_release'],
  },
  {
    key: 'stage7', emoji: '🟫',
    titleCn: '阶段 7：物流收款',
    stepKeys: ['booking_done', 'customs_export', 'finance_shipment_approval', 'shipment_execute', 'payment_received'],
  },
];

// 统一状态判断：使用标准化函数
const _isDone = (s: string) => isDoneStatus(s);
const _isActive = (s: string) => isActiveStatus(s);
const _isPending = (s: string) => isPendingStatus(s);
const _isBlocked = (s: string) => isBlockedStatus(s);
const _statusLabel = (s: string) => normalizeMilestoneStatus(s);

const STATUS_STYLE: Record<string, string> = {
  '未开始': 'bg-gray-100 text-gray-600',
  'pending': 'bg-gray-100 text-gray-600',
  '进行中': 'bg-blue-100 text-blue-700',
  'in_progress': 'bg-blue-100 text-blue-700',
  '已完成': 'bg-green-100 text-green-700',
  'done': 'bg-green-100 text-green-700',
  '卡单':   'bg-orange-100 text-orange-700',
  '卡住':   'bg-orange-100 text-orange-700',
  '阻塞':   'bg-orange-100 text-orange-700',
  'blocked': 'bg-orange-100 text-orange-700',
};

/** 实际/预计日期输入组件 */
function ActualDateInput({ milestoneId, currentActualAt, dueAt }: {
  milestoneId: string;
  currentActualAt: string | null;
  dueAt: string | null;
}) {
  const msgTimerRef = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => { return () => { if (msgTimerRef.current) clearTimeout(msgTimerRef.current); }; }, []);
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
      if (msgTimerRef.current) clearTimeout(msgTimerRef.current);
      msgTimerRef.current = setTimeout(() => setMsg(''), 2000);
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

export function OrderTimeline({ milestones, orderId, orderNo, orderIncoterm, currentRole, currentRoles = [], currentUserId, isAdmin = false }: OrderTimelineProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, any[]>>({});
  const [showPOParser, setShowPOParser] = useState(false);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  // ── Swim-lane filter ──
  // 默认按当前用户角色显示对应泳道。
  // 用户可手动切换到「全部」或单独某条 lane。不锁死。
  const defaultLanes = useMemo(() => {
    const roles = currentRoles.length > 0 ? currentRoles : (currentRole ? [currentRole] : []);
    return getDefaultLanesForRoles(roles);
  }, [currentRole, currentRoles]);
  // null = 显示全部；SwimLane[] = 仅显示指定 lanes
  const [laneFilter, setLaneFilter] = useState<SwimLane[] | null>(
    defaultLanes.length === 3 ? null : defaultLanes,
  );
  const totalByLane = useMemo(() => {
    const acc: Record<SwimLane, number> = { sales: 0, production: 0, sync: 0 };
    for (const m of milestones) {
      const lane = getSwimLane((m as any).step_key);
      acc[lane]++;
    }
    return acc;
  }, [milestones]);

  // 从 URL ?focus=<milestone_id> 自动滚动+展开+高亮
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const focus = params.get('focus');
    if (focus) {
      setFocusedId(focus);
      setExpandedId(focus);
      // 延迟滚动等渲染完成
      setTimeout(() => {
        const el = document.getElementById(`milestone-${focus}`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 300);
      // 5秒后清除高亮
      setTimeout(() => setFocusedId(null), 5000);
    }
  }, []);

  useEffect(() => {
    let stale = false;
    if (expandedId) {
      getMilestoneLogs(expandedId).then(r => {
        if (!stale && r.data) setLogs({ [expandedId]: r.data });
      });
    } else {
      setLogs({});
    }
    return () => { stale = true; };
  }, [expandedId]);

  // ════════ 节点显示顺序：永久固定 ════════
  // 修复 2026-04-08：之前用 due_at 排序，但旧订单的 due_at 可能被手工改过
  // 或排期 bug 留下了"客户确认 due_at < 准备完成 due_at"这种坏数据 →
  // 按 due_at 排会出现"产前样客户确认排在产前样准备完成之前"的逻辑荒谬。
  //
  // 现在改为：阶段内的节点顺序 = MILESTONE_GROUPS.stepKeys 数组里的位置
  // 这是模板硬编码的业务逻辑顺序，永远不会乱：
  //   产前样准备完成 → 产前样寄出 → 产前样客户确认
  //   永远不会反过来，无论 due_at 数据怎么坏。
  //
  // due_at 只用于"全局节点排序"（跨阶段），不影响阶段内顺序。

  // 全局兜底排序（极少数节点不在 MILESTONE_GROUPS 时用）
  const sorted = [...milestones].sort((a, b) => {
    const aN = (a as any).sequence_number ?? 99;
    const bN = (b as any).sequence_number ?? 99;
    return aN - bN;
  });

  // Swim-lane 过滤：null = 全部；否则只保留指定 lane 的节点
  const laneFilteredMilestones = useMemo(() => {
    if (laneFilter === null) return milestones;
    const allowed = new Set(laneFilter);
    return milestones.filter(m => allowed.has(getSwimLane((m as any).step_key)));
  }, [milestones, laneFilter]);

  // 阶段内：按 stepKeys 数组里的位置排序（永久固定的逻辑顺序）
  const grouped = MILESTONE_GROUPS.map(g => {
    const items = laneFilteredMilestones.filter(m => g.stepKeys.includes((m as any).step_key));
    items.sort((a, b) => {
      const aIdx = g.stepKeys.indexOf((a as any).step_key);
      const bIdx = g.stepKeys.indexOf((b as any).step_key);
      return aIdx - bIdx;
    });
    return { ...g, items };
  });

  // Lane filter helpers
  const isLaneActive = (lane: SwimLane) => laneFilter !== null && laneFilter.length === 1 && laneFilter[0] === lane;
  const isAllActive = laneFilter === null;
  const isMyLanesActive =
    laneFilter !== null &&
    laneFilter.length === defaultLanes.length &&
    laneFilter.every(l => defaultLanes.includes(l));
  const toggleLane = (lane: SwimLane) => {
    setLaneFilter(prev => {
      if (prev === null) return [lane];                 // 从「全部」点单 lane → 只显示该 lane
      if (prev.length === 1 && prev[0] === lane) return null; // 再次点 → 取消，回到全部
      return [lane];
    });
  };

  return (
    <div className="space-y-6">
      {/* ── Swim-lane Filter ── */}
      <div className="flex flex-wrap items-center gap-2 px-1">
        <span className="text-xs text-gray-500 mr-1">视图：</span>

        <button
          onClick={() => setLaneFilter(null)}
          className={`text-xs px-3 py-1.5 rounded-full transition ${
            isAllActive ? 'bg-gray-900 text-white' : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-50'
          }`}
        >
          全部 ({milestones.length})
        </button>

        {defaultLanes.length < 3 && (
          <button
            onClick={() => setLaneFilter(defaultLanes)}
            className={`text-xs px-3 py-1.5 rounded-full transition ${
              isMyLanesActive ? 'bg-indigo-600 text-white' : 'bg-white border border-indigo-300 text-indigo-700 hover:bg-indigo-50'
            }`}
            title={`默认根据当前角色显示：${defaultLanes.map(l => LANE_META[l].label).join(' + ')}`}
          >
            我的视图
          </button>
        )}

        {(['sales', 'production', 'sync'] as SwimLane[]).map(lane => {
          const meta = LANE_META[lane];
          const active = isLaneActive(lane);
          return (
            <button
              key={lane}
              onClick={() => toggleLane(lane)}
              className={`text-xs px-3 py-1.5 rounded-full transition flex items-center gap-1.5 ${
                active ? meta.pillClass : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-50'
              }`}
            >
              <span className={`w-2 h-2 rounded-full ${active ? 'bg-white/80' : meta.dotClass}`} />
              {meta.label} ({totalByLane[lane]})
            </button>
          );
        })}

        {laneFilter !== null && !isMyLanesActive && (
          <span className="text-[11px] text-gray-400 ml-1">
            {laneFilteredMilestones.length === 0 ? '当前 filter 下无节点' : `共 ${laneFilteredMilestones.length} 节点`}
          </span>
        )}
      </div>

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
                    id={`milestone-${m.id}`}
                    className={'px-5 py-4 transition-all ' + (
                      focusedId === m.id ? 'ring-4 ring-amber-400 bg-amber-50' :
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
                          {(() => {
                            const lane = getSwimLane(m.step_key);
                            const laneMeta = LANE_META[lane];
                            return (
                              <span
                                className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${laneMeta.badgeClass}`}
                                title={`泳道：${laneMeta.label}`}
                              >
                                {laneMeta.shortLabel}
                              </span>
                            );
                          })()}
                          <span className={'text-xs px-2 py-0.5 rounded-full font-medium ' + (STATUS_STYLE[m.status] || STATUS_STYLE['未开始'])}>
                            {_statusLabel(m.status)}
                          </span>
                          {m.is_critical && !isDone && (
                            <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">关键</span>
                          )}
                          {overdue && !isDone && !isBlocked && (() => {
                            // 严格按 owner_user_id 判断 — 否则同 role 的同事会被误标成"我的逾期"
                            // 改动：pending（未开始）但已过截止日期也要显示逾期 badge，让责任人能看到
                            const isMineOverdue = !isAdmin && !!currentUserId && (m as any).owner_user_id === currentUserId;
                            const roleName = getRoleLabel(m.owner_role);
                            return isMineOverdue
                              ? <span className="text-xs px-2 py-0.5 rounded-full bg-red-600 text-white font-medium">🔴 我的逾期</span>
                              : <span className="text-xs px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 font-medium">⚠ {roleName}逾期</span>;
                          })()}
                          {/* 逾期完成徽章（已完成节点专用） — 让 CEO/督导/下游一眼看到 */}
                          {isDone && (() => {
                            const days = computeDelayDays(m.actual_at, m.due_at);
                            if (days <= 0) return null;
                            if (days > 3) {
                              return <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium" title="将影响订单评分">🚨 逾期 {days} 天完成</span>;
                            }
                            return <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-700 font-medium" title="将影响订单评分">⚠ 逾期 {days} 天完成</span>;
                          })()}
                          {/* SOP 按钮 */}
                          {(() => {
                            const sop = getSOPForStep(m.step_key);
                            return sop ? <SOPButton stepKey={m.step_key} milestoneName={m.name} sop={sop} /> : null;
                          })()}
                        </div>

                        {/* 元信息行 */}
                        <div className="flex flex-wrap gap-x-3 md:gap-x-4 gap-y-1 text-[11px] md:text-xs text-gray-500">
                          <span>责任人：{m.owner_user?.name || m.owner_user?.email?.split('@')[0] || `未分配（${getRoleLabel(m.owner_role)}）`}</span>
                          {m.deadline_hint && <span>时限：{m.deadline_hint}</span>}
                          {m.due_at && (() => {
                            if (!overdue || isDone || isBlocked) return (
                              <span title={`截止：${formatDateTime(m.due_at)}`}>截止：{formatDate(m.due_at)}</span>
                            );
                            const isMineOverdue = !isAdmin && !!currentUserId && (m as any).owner_user_id === currentUserId;
                            return (
                              <span
                                title={`截止：${formatDateTime(m.due_at)}`}
                                className={isMineOverdue ? 'text-red-600 font-semibold' : 'text-orange-500 font-medium'}
                              >
                                截止：{formatDate(m.due_at)}
                              </span>
                            );
                          })()}
                          {m.actual_at && (
                            <span
                              className={
                                computeDeliveryAlert(m.actual_at, m.due_at) === 'RED' ? 'text-red-600 font-semibold' :
                                computeDeliveryAlert(m.actual_at, m.due_at) === 'YELLOW' ? 'text-yellow-600 font-semibold' :
                                'text-green-600'
                              }
                            >
                              完成：{formatDateTime(m.actual_at)}
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
                        {/* 实际/预计日期输入（仅关键生产节点 + 对应角色） */}
                        {ACTUAL_DATE_EDITABLE_KEYS.includes(m.step_key) && !_isDone(m.status) && !isAdmin && (() => {
                          const dateRoles = currentRoles.length > 0 ? currentRoles : (currentRole ? [currentRole] : []);
                          const mRole2 = (m.owner_role || '').toLowerCase();
                          return dateRoles.some(r => {
                            const nr = r.toLowerCase();
                            return nr === mRole2 || (mRole2 === 'sales' && nr === 'merchandiser') || (mRole2 === 'merchandiser' && nr === 'sales');
                          });
                        })() && (
                          <ActualDateInput
                            milestoneId={m.id}
                            currentActualAt={m.actual_at}
                            dueAt={m.due_at}
                          />
                        )}

                        {/* AI 生成生产单按钮（仅生产单上传节点） */}
                        {m.step_key === 'production_order_upload' && (
                          <button
                            onClick={() => setShowPOParser(true)}
                            className="w-full py-2.5 rounded-lg bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white text-sm font-medium transition-all flex items-center justify-center gap-2"
                          >
                            <span>✨</span> AI 生成生产单（上传客户 PO 自动填充）
                          </button>
                        )}

                        <OwnerAssignment
                          milestoneId={m.id}
                          currentOwnerUserId={m.owner_user_id}
                          isAdmin={isAdmin}
                          isProductionManager={currentRoles.includes('production_manager')}
                          milestoneStatus={m.status}
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

                        {/* 核心操作区：MilestoneActions（去处理 + 申请延期）— 仅对应角色可见 */}
                        <MilestoneActions
                          milestone={m}
                          allMilestones={sorted}
                          currentRole={currentRole}
                          currentRoles={currentRoles}
                          currentUserId={currentUserId}
                          isAdmin={isAdmin}
                          orderId={orderId}
                          orderNo={orderNo}
                        />

                        {/* 催办提醒按钮：所有未完成节点可催办（2026-05-15 放宽）
                            - 跨角色催办时 API 自动抄送 admin/CEO
                            - 1 小时内同节点只能催 1 次 */}
                        {!_isDone(m.status) && (() => {
                          // 判断是否跨角色（仅用于 UI 文案，实际抄送由后端决定）
                          const milestoneRole = String(m.owner_role || '').toLowerCase();
                          const sameRoleGroup = (a: string, b: string) => {
                            if (a === b) return true;
                            const prodGroup = ['merchandiser', 'production', 'production_manager', 'qc', 'quality'];
                            if (prodGroup.includes(a) && prodGroup.includes(b)) return true;
                            const salesGroup = ['sales', 'sales_assistant'];
                            if (salesGroup.includes(a) && salesGroup.includes(b)) return true;
                            return false;
                          };
                          const myRoles = currentRoles.length > 0 ? currentRoles : (currentRole ? [currentRole] : []);
                          const isCross = milestoneRole && myRoles.length > 0 && !myRoles.some(r => sameRoleGroup(String(r).toLowerCase(), milestoneRole));
                          return (
                            <div className={`rounded-lg p-3 flex items-center justify-between ${isCross ? 'bg-purple-50' : 'bg-blue-50'}`}>
                              <div className="text-xs">
                                <span className={`font-medium ${isCross ? 'text-purple-700' : 'text-blue-700'}`}>
                                  负责人：{m.owner_user?.name || m.owner_user?.email?.split('@')[0] || '未分配'}
                                </span>
                                <span className={`ml-2 ${isCross ? 'text-purple-500' : 'text-blue-500'}`}>
                                  {getRoleLabel(m.owner_role)}
                                </span>
                                {isCross && (
                                  <span className="ml-2 text-purple-600 font-medium">（跨部门）</span>
                                )}
                              </div>
                              <button
                                onClick={async () => {
                                  const reason = isCross
                                    ? prompt(`要催办其他部门的「${m.name}」？\n\n这条催办会自动抄送给 admin/CEO。\n（可选）填写催办理由，例：客户催进度 / 你们这边已耽误 3 天 / 影响后续我的节点：`)
                                    : prompt(`要发送催办提醒给「${m.name}」的负责人？\n（可选）填写催办理由：`);
                                  if (reason === null) return; // 用户取消
                                  try {
                                    const res = await fetch('/api/nudge', {
                                      method: 'POST',
                                      headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({ milestoneId: m.id, message: reason || '' }),
                                    });
                                    const json = await res.json();
                                    if (json.error) alert(json.error);
                                    else {
                                      const ccInfo = json.ccAdminSent ? `\n✅ 已抄送 ${json.ccAdminCount} 位管理员` : '';
                                      alert(`催办已发送：${json.message}${ccInfo}`);
                                    }
                                  } catch { alert('发送失败'); }
                                }}
                                className={`text-xs px-3 py-1.5 rounded-lg text-white font-medium ${isCross ? 'bg-purple-600 hover:bg-purple-700' : 'bg-blue-600 hover:bg-blue-700'}`}
                              >
                                {isCross ? '📢 催办（抄送老板）' : '📧 催办提醒'}
                              </button>
                            </div>
                          );
                        })()}

                        {/* 凭证上传统一在 MilestoneActions 的「提交进度」表单里完成
                            （之前此处的 EvidenceUpload 双入口已于 2026-04-15 合并） */}

                        {!_isDone(m.status) && !isAdmin &&
                          (currentRoles.length > 0 ? currentRoles : (currentRole ? [currentRole] : [])).some(r => {
                            const nr = r.toLowerCase(); const or2 = (m.owner_role || '').toLowerCase();
                            return nr === or2 || (or2 === 'qc' && nr === 'quality') || (or2 === 'sales' && nr === 'merchandiser') || (or2 === 'merchandiser' && nr === 'sales');
                          }) && (
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
                                  <p className="text-gray-400 mt-0.5">
                                    {log.actor_name && <span className="text-gray-500">{log.actor_name} · </span>}
                                    {formatDateTime(log.created_at)}
                                  </p>
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

      {/* AI 生产单生成弹窗 */}
      {showPOParser && (
        <POParserModal orderId={orderId} onClose={() => setShowPOParser(false)} />
      )}
    </div>
  );
}
