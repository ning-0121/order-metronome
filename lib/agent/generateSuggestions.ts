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
): AgentSuggestion[] {
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
    if (days < 2) continue;

    const owner = profiles.find(p => p.user_id === m.owner_user_id);
    const ownerName = owner?.name || '负责人';

    add(
      'send_nudge', days >= 5 ? 'high' : 'medium', 70 + days,
      `「${m.name}」已超期 ${days} 天，建议催办 ${ownerName}`,
      `该节点截止日期为 ${m.due_at?.slice(0, 10)}，已超期 ${days} 天。`,
      `超期节点影响后续所有环节的排期。`,
      { target_user_id: m.owner_user_id, target_name: ownerName, days_overdue: days },
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

  // 按优先级排序，取 top N
  suggestions.sort((a, b) => b._priority - a._priority);
  return suggestions.slice(0, CIRCUIT_BREAKER.maxSuggestionsPerOrder).map(s => {
    const { _priority, ...rest } = s;
    return rest;
  });
}
