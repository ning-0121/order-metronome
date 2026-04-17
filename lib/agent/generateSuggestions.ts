/**
 * Phase 1 AI Agent — 规则引擎建议生成器
 *
 * 纯规则，不调用 Claude API。
 * 每单最多生成 3 条建议，按 severity 排序。
 * 用 dedup_key 防止重复生成。
 */

import { isOverdue } from '@/lib/utils/date';
import { isDoneStatus, isActiveStatus, isBlockedStatus } from '@/lib/domain/types';
import type { AgentSuggestion, AgentActionType, AgentSeverity } from './types';
import { CIRCUIT_BREAKER } from './types';
import type { CustomerProfile } from './customerProfile';
import { getNudgeThreshold } from './customerProfile';
import { MILESTONE_RISK_MATRIX } from './industryKnowledge';

interface OrderData {
  id: string;
  order_no: string;
  customer_name: string;
  factory_name?: string;
}

interface MilestoneData {
  id: string;
  step_key: string;
  name: string;
  status: string;
  due_at: string | null;
  owner_role: string | null;
  owner_user_id: string | null;
  evidence_required: boolean;
  is_critical: boolean;
}

interface ProfileData {
  user_id: string;
  name: string | null;
  email: string;
  roles: string[];
}

interface ExistingAction {
  dedup_key: string;
  status: string;
  created_at: string;
}

function makeDedupKey(orderId: string, actionType: string, milestoneId?: string): string {
  return `${orderId}:${actionType}:${milestoneId || 'order'}`;
}

function isDuplicate(key: string, existing: ExistingAction[]): boolean {
  // 永久去重：只要 dedup_key 相同，不论状态都跳过
  // 避免同一个建议因 cron 反复扫描被重新生成（即使已被用户 dismissed 或 executed）
  // 如需让"已执行/已忽略"的建议能重新生成，用户需手动触发 reset 或删除历史记录
  return existing.some(a => a.dedup_key === key);
}

function daysOverdue(dueAt: string | null): number {
  if (!dueAt) return 0;
  const diff = Date.now() - new Date(dueAt).getTime();
  return Math.max(0, Math.floor(diff / (24 * 60 * 60 * 1000)));
}

function findUserByRole(role: string, profiles: ProfileData[]): ProfileData | null {
  const matches = profiles.filter(p => p.roles.includes(role));
  return matches.length === 1 ? matches[0] : null;
}

export function generateSuggestionsForOrder(
  order: OrderData,
  milestones: MilestoneData[],
  profiles: ProfileData[],
  existingActions: ExistingAction[],
  customerProfile?: CustomerProfile | null,
  attachmentTypes?: string[],
): AgentSuggestion[] {
  const nudgeThreshold = getNudgeThreshold(customerProfile || null);
  const suggestions: Array<AgentSuggestion & { _priority: number }> = [];

  function add(
    actionType: AgentActionType,
    severity: AgentSeverity,
    priority: number,
    title: string,
    description: string,
    reason: string,
    payload: Record<string, any>,
    milestoneId?: string,
    milestoneName?: string,
    confirmMessage?: string,
  ) {
    const key = makeDedupKey(order.id, actionType, milestoneId);
    if (isDuplicate(key, existingActions)) return;

    const { ACTION_CONFIG } = require('./types');
    const config = ACTION_CONFIG[actionType];

    suggestions.push({
      id: '', // 由数据库生成
      orderId: order.id,
      orderNo: order.order_no,
      milestoneId,
      milestoneName,
      actionType,
      title,
      description,
      reason,
      severity,
      primaryButton: {
        label: config.buttonLabel,
        confirmMessage: confirmMessage || config.confirmMessage,
      },
      payload: { ...payload, dedup_key: key },
      status: 'pending',
      canRollback: config.canRollback,
      _priority: priority,
    });
  }

  // ── 规则 1: 无负责人的节点 ──
  for (const m of milestones) {
    if (isDoneStatus(m.status)) continue;
    if (m.owner_user_id) continue;
    if (!m.owner_role) continue;

    const candidate = findUserByRole(m.owner_role, profiles);
    if (candidate) {
      add(
        'assign_owner', 'medium', 60,
        `建议将「${m.name}」分配给 ${candidate.name || candidate.email.split('@')[0]}`,
        `该节点（${m.name}）尚未指定负责人，角色为${m.owner_role}。`,
        `未分配的节点无人推进，可能导致延误。`,
        { target_user_id: candidate.user_id, target_name: candidate.name || candidate.email.split('@')[0] },
        m.id, m.name,
      );
    }
  }

  // ── 规则 2: 超期催办 ──
  for (const m of milestones) {
    if (isDoneStatus(m.status)) continue;
    if (!isActiveStatus(m.status)) continue;
    if (!m.due_at || !isOverdue(m.due_at)) continue;
    if (!m.owner_user_id) continue;

    const days = daysOverdue(m.due_at);
    if (days < nudgeThreshold) continue;

    const owner = profiles.find(p => p.user_id === m.owner_user_id);
    const ownerName = owner?.name || '负责人';
    const profileNote = customerProfile ? ` (该客户历史延期率${customerProfile.delayRate}%)` : '';

    add(
      'send_nudge', days >= 5 ? 'high' : 'medium', 70 + days,
      `「${m.name}」已超期 ${days} 天，建议催办 ${ownerName}`,
      `该节点截止日期为 ${m.due_at?.slice(0, 10)}，已超期 ${days} 天。${profileNote}`,
      `超期节点影响后续所有环节的排期。${days >= 3 ? ' 催办后48小时无回应将自动升级CEO。' : ''}`,
      {
        target_user_id: m.owner_user_id, target_name: ownerName, days_overdue: days,
        // 链式动作：催办→48h后升级CEO（仅超期≥3天触发）
        ...(days >= 3 ? { chain_next_type: 'escalate_ceo', chain_delay_hours: 48, chain_id: `chain-${order.id}-${m.id}` } : {}),
      },
      m.id, m.name,
    );
  }

  // ── 规则 3: 严重超期建议延期 ──
  for (const m of milestones) {
    if (isDoneStatus(m.status)) continue;
    if (!m.due_at || !isOverdue(m.due_at)) continue;

    const days = daysOverdue(m.due_at);
    if (days < 5) continue;

    add(
      'create_delay_draft', 'high', 80 + days,
      `「${m.name}」严重超期 ${days} 天，建议申请延期`,
      `该节点已超期 ${days} 天，未提交延期申请。不申请延期将影响订单评分。`,
      `严重超期需通过正式延期流程处理，以便调整下游排期。`,
      { days_overdue: days, suggested_days: Math.min(days + 3, 14) },
      m.id, m.name,
    );
  }

  // ── 规则 4: 升级 CEO ──
  const overdueCount = milestones.filter(m =>
    !isDoneStatus(m.status) && m.due_at && isOverdue(m.due_at)
  ).length;
  const blockedCount = milestones.filter(m => isBlockedStatus(m.status)).length;

  if (overdueCount >= 3 || blockedCount >= 2) {
    add(
      'escalate_ceo', 'high', 90,
      `订单 ${order.order_no} 风险极高，建议升级 CEO 关注`,
      `${overdueCount} 个节点超期，${blockedCount} 个节点阻塞。`,
      `多节点同时异常表明系统性问题，需管理层介入协调。`,
      { overdue_count: overdueCount, blocked_count: blockedCount },
    );
  }

  // ── 规则 5: 缺失凭证提醒（检查附件后再告警）──
  // 节点 step_key → 对应的附件 file_type 映射
  const stepToFileType: Record<string, string[]> = {
    po_confirmed: ['customer_po'],
    production_order_upload: ['production_order', 'trims_sheet', 'packing_requirement'],
    finance_approval: ['internal_quote', 'customer_quote'],
    processing_fee_confirmed: ['internal_quote'],
    procurement_order_placed: ['procurement_order'],
    mid_qc_check: ['qc_report'],
    final_qc_check: ['qc_report'],
    inspection_release: ['qc_report'],
    sample_sent: ['tech_pack'],
    booking_done: ['packing_list'],
    customs_export: ['packing_list'],
    shipment_execute: ['packing_list'],
  };
  const uploads = attachmentTypes || [];

  for (const m of milestones) {
    if (!isDoneStatus(m.status)) continue;
    if (!m.evidence_required) continue;

    // 如果有对应文件类型映射，检查是否已上传
    const requiredTypes = stepToFileType[m.step_key];
    if (requiredTypes) {
      const hasEvidence = requiredTypes.some(t => uploads.includes(t));
      if (hasEvidence) continue; // 已有附件，不告警
    } else {
      // 没有明确映射的节点，如果订单有任何附件就不告警
      if (uploads.length > 0) continue;
    }

    add(
      'remind_missing_doc', 'low', 30,
      `「${m.name}」已完成但缺少凭证文件`,
      `该节点要求上传凭证，请上传相关文件。`,
      `缺少凭证将影响订单复盘和审计。`,
      {},
      m.id, m.name,
    );
  }

  // ── 规则 5.5: 预测性提醒（Feature Flag 控制）──
  const { AGENT_FLAGS } = require('./featureFlags');
  if (AGENT_FLAGS.predictiveWarning()) for (const m of milestones) {
    if (isDoneStatus(m.status)) continue;
    if (!m.due_at) continue;
    const dueDate = new Date(m.due_at);
    const now = new Date();
    const daysLeft = Math.ceil((dueDate.getTime() - now.getTime()) / 86400000);
    // 2-3天内到期 + 节点还没开始 → 预警
    if (daysLeft >= 1 && daysLeft <= 3 && !isActiveStatus(m.status)) {
      const owner = m.owner_user_id ? profiles.find(p => p.user_id === m.owner_user_id) : null;
      add(
        'send_nudge', 'medium', 55 + (3 - daysLeft) * 5,
        `「${m.name}」${daysLeft}天后到期但未启动，建议提前准备`,
        `截止日期 ${m.due_at?.slice(0, 10)}，仅剩 ${daysLeft} 天${m.is_critical ? '（关键节点）' : ''}。`,
        `提前介入可避免超期。节点尚未进入"进行中"状态。`,
        { target_user_id: m.owner_user_id, target_name: owner?.name || '负责人', days_left: daysLeft, is_prediction: true },
        m.id, m.name,
      );
    }
  }

  // ── 规则 6: 节点完成后通知下一节点负责人 ──
  const sortedMilestones = [...milestones].sort((a, b) => {
    if (!a.due_at || !b.due_at) return 0;
    return a.due_at.localeCompare(b.due_at);
  });
  for (let i = 0; i < sortedMilestones.length - 1; i++) {
    const current = sortedMilestones[i];
    const next = sortedMilestones[i + 1];
    if (!isDoneStatus(current.status)) continue;
    if (isDoneStatus(next.status)) continue;
    if (!next.owner_user_id) continue;
    // 当前刚完成（3天内）且下一个还没开始
    if (!isActiveStatus(next.status) && !isBlockedStatus(next.status)) {
      const nextOwner = profiles.find(p => p.user_id === next.owner_user_id);
      if (nextOwner) {
        add(
          'notify_next', 'medium', 50,
          `「${current.name}」已完成，建议通知 ${nextOwner.name || nextOwner.email.split('@')[0]} 启动「${next.name}」`,
          `前置节点已完成，下一节点可以开始。`,
          `及时推进避免空等。`,
          { target_user_id: next.owner_user_id, target_name: nextOwner.name, next_milestone_name: next.name },
          next.id, next.name,
        );
      }
    }
  }

  // ── 规则 7: 生产阶段订单无日报提醒 ──
  const productionStarted = milestones.some(m => m.step_key === 'production_kickoff' && isDoneStatus(m.status));
  const factoryDone = milestones.some(m => m.step_key === 'factory_completion' && isDoneStatus(m.status));
  if (productionStarted && !factoryDone) {
    const merchMilestone = milestones.find(m => m.owner_role === 'merchandiser' && m.owner_user_id);
    if (merchMilestone?.owner_user_id) {
      const merch = profiles.find(p => p.user_id === merchMilestone.owner_user_id);
      if (merch) {
        add(
          'send_nudge', 'low', 40,
          `订单 ${order.order_no} 生产中，提醒 ${merch.name || '跟单'} 提交日报`,
          `该订单已进入生产阶段，请每日更新生产进度。`,
          `日报有助于及时发现产能问题和品质风险。`,
          { target_user_id: merch.user_id, target_name: merch.name, is_daily_report_reminder: true },
          undefined, undefined,
        );
      }
    }
  }

  // ── 规则 8: 采购节点专项 ──
  // 当前审计：采购类阻塞占全系统阻塞的 ~50%，原有规则对此无专项处理
  const PROCUREMENT_STEPS = new Set([
    'bom_confirmed', 'procurement_order_placed', 'material_inspection',
    'processing_fee_confirmed', 'factory_match_confirmed',
  ]);
  for (const m of milestones) {
    if (!PROCUREMENT_STEPS.has(m.step_key)) continue;
    if (isDoneStatus(m.status)) continue;

    // 采购节点阻塞超 3 天 → 建议升级采购负责人，附行业常见原因
    if (isBlockedStatus(m.status)) {
      const days = daysOverdue(m.due_at);
      const procUser = m.owner_user_id ? profiles.find(p => p.user_id === m.owner_user_id) : null;
      const riskInfo = MILESTONE_RISK_MATRIX[m.step_key];
      const causeHint = riskInfo ? `常见原因：${riskInfo.commonCauses.slice(0, 2).join('、')}。` : '';
      const tipHint = riskInfo ? `处理建议：${riskInfo.preventionTips[0]}。` : '';
      add(
        'escalate_ceo', days >= 5 ? 'high' : 'medium', 85 + days,
        `采购节点「${m.name}」已阻塞${days > 0 ? ` ${days} 天` : ''}，需升级协调`,
        `采购阻塞会连锁导致原料无法到货、生产无法启动。负责人：${procUser?.name || m.owner_role || '未分配'}。${causeHint}`,
        `${tipHint}请 CEO 直接介入协调采购/供应商，解除阻塞后立即重新排期。`,
        { blocked_step: m.step_key, days_blocked: days, common_causes: riskInfo?.commonCauses },
        m.id, m.name,
        `确认升级「${m.name}」阻塞问题到 CEO？`,
      );
    }

    // BOM/采购预评估 + 面料已确认 → 提示平行下单辅料
    if (m.step_key === 'bom_confirmed' && !isDoneStatus(m.status)) {
      const fabricOrdered = milestones.some(ms => ms.step_key === 'procurement_order_placed' && !isDoneStatus(ms.status));
      if (fabricOrdered) {
        add(
          'add_note', 'medium', 72,
          `「BOM确认」和「采购下单」同时推进中 — 记得辅料和面料同步下单`,
          `⚠️ 需配色的辅料（拉链/网纱等）要用布样/小样提前染色，不要等大货面料到了再染！否则面料15天+辅料染色10天=生产时间不足10天。`,
          `平行采购是避免采购卡点的核心原则（CEO 2026-04-15 确认）。`,
          { note: '辅料和面料同步下单，辅料配色用布样提前染', step_key: m.step_key },
          m.id, m.name,
        );
      }
    }

    // 原辅料验收逾期 → 预警生产启动时间
    if (m.step_key === 'material_inspection' && m.due_at && isOverdue(m.due_at)) {
      const overdueDays = daysOverdue(m.due_at);
      const productionStep = milestones.find(ms => ms.step_key === 'production_kickoff');
      if (productionStep && !isDoneStatus(productionStep.status)) {
        add(
          'create_delay_draft', 'high', 88,
          `原辅料验收逾期 ${overdueDays} 天，生产启动将连带延误`,
          `原辅料验收是生产启动的前置条件。当前逾期 ${overdueDays} 天，如不解决则生产启动至少推迟 ${overdueDays} 天，影响出厂日期。`,
          `请立即处理原辅料到货/验收问题，或评估是否需要申请整体延期。`,
          { overdue_days: overdueDays, impact_step: 'production_kickoff' },
          m.id, m.name,
        );
      }
    }
  }

  // ── 规则 9: 出运前卡点专项（订单出厂日≤7天时升级） ──
  // 针对出货阶段高频阻塞：品控/验货/订舱/出运
  const SHIPMENT_STEPS = new Set([
    'mid_qc_check', 'final_qc_check', 'inspection_release',
    'booking_done', 'customs_export', 'shipment_execute', 'sample_sent',
  ]);
  for (const m of milestones) {
    if (!SHIPMENT_STEPS.has(m.step_key)) continue;
    if (isDoneStatus(m.status)) continue;
    if (!isBlockedStatus(m.status) && !(m.due_at && isOverdue(m.due_at))) continue;

    const days = daysOverdue(m.due_at);
    add(
      'escalate_ceo', 'high', 95 + days,
      `出货关键节点「${m.name}」${isBlockedStatus(m.status) ? '阻塞' : `逾期 ${days} 天`} — 出运风险极高`,
      `出货阶段节点阻塞/逾期将直接导致船期延误。节点：${m.name}。`,
      `订舱截止时间不等人，请立即协调解决。`,
      { step_key: m.step_key, days_overdue: days, is_shipment_critical: true },
      m.id, m.name,
      `确认升级出货卡点「${m.name}」到 CEO？`,
    );
  }

  // ── 规则 10: 收款节点逾期提醒 ──
  for (const m of milestones) {
    if (m.step_key !== 'payment_received') continue;
    if (isDoneStatus(m.status)) continue;
    if (!m.due_at || !isOverdue(m.due_at)) continue;

    const days = daysOverdue(m.due_at);
    const financeUser = profiles.find(p => p.roles.includes('finance'));
    add(
      'send_nudge', days >= 14 ? 'high' : 'medium', 75 + days,
      `收款节点已逾期 ${days} 天，提醒财务跟催`,
      `出货后应在 30 天内收款。当前已逾期 ${days} 天，客户：${order.customer_name}。`,
      `逾期收款影响公司现金流，超 30 天需考虑升级处理。`,
      { target_user_id: financeUser?.user_id, target_name: financeUser?.name || '财务', days_overdue: days, customer: order.customer_name },
      m.id, m.name,
    );
  }

  // ── 规则 11: 产前样客户确认逾期 → 主动联系客户 ──
  for (const m of milestones) {
    if (m.step_key !== 'pre_production_sample_confirm' && m.step_key !== 'sample_customer_confirm') continue;
    if (isDoneStatus(m.status)) continue;
    if (!m.due_at || !isOverdue(m.due_at)) continue;

    const days = daysOverdue(m.due_at);
    const salesUser = m.owner_user_id ? profiles.find(p => p.user_id === m.owner_user_id) : null;
    const profileNote = customerProfile ? `（该客户历史样品确认平均 ${customerProfile.avgSampleConfirmDays ?? '?'} 天）` : '';
    add(
      'send_nudge', days >= 3 ? 'high' : 'medium', 78 + days,
      `产前样客户确认已逾期 ${days} 天，提醒 ${salesUser?.name || '业务'} 跟催`,
      `产前样确认是生产启动的前置条件，客户迟迟未确认将阻塞后续所有节点。${profileNote}`,
      `请业务立即联系客户，明确给出确认时间或反馈意见。`,
      { target_user_id: m.owner_user_id, target_name: salesUser?.name || '业务', days_overdue: days, customer: order.customer_name },
      m.id, m.name,
    );
  }

  // 按优先级排序，取 top N
  suggestions.sort((a, b) => b._priority - a._priority);
  return suggestions.slice(0, CIRCUIT_BREAKER.maxSuggestionsPerOrder).map(s => {
    const { _priority, ...rest } = s;
    return rest;
  });
}
