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
  const now = Date.now();
  return existing.some(a => {
    if (a.dedup_key !== key) return false;
    if (a.status === 'pending') return true;
    // 已执行/已忽略的 24 小时内不重复
    const age = now - new Date(a.created_at).getTime();
    return age < 24 * 60 * 60 * 1000;
  });
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

  // ── 规则 5: 缺失凭证提醒 ──
  for (const m of milestones) {
    if (!isDoneStatus(m.status)) continue;
    if (!m.evidence_required) continue;
    // 这里不检查附件表（避免 N+1 查询），由执行时检查
    add(
      'remind_missing_doc', 'low', 30,
      `「${m.name}」已完成但可能缺少凭证文件`,
      `该节点要求上传凭证，请检查是否已上传。`,
      `缺少凭证将影响订单复盘和审计。`,
      {},
      m.id, m.name,
    );
  }

  // ── 规则 5.5: 预测性提醒 — 即将超期预警 ──
  for (const m of milestones) {
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
    // 找跟单负责人
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

  // 按优先级排序，取 top N
  suggestions.sort((a, b) => b._priority - a._priority);
  return suggestions.slice(0, CIRCUIT_BREAKER.maxSuggestionsPerOrder).map(s => {
    const { _priority, ...rest } = s;
    return rest;
  });
}
