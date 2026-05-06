/**
 * Delivery Confidence Engine — Phase 1 纯函数
 *
 * 核心原则：
 *  1. 关键节点（CRITICAL_STEP_KEYS）才显著扣分；非关键节点延期只小幅影响
 *  2. blocked + 无处理方案 → 强制 < 50（红）
 *  3. 已批准延期 + 缓冲够 → 黄而不是红
 *  4. 已出运 → 切换到付款风险视角，不再算排期
 *  5. explain_json 必须人类可读：headline / reasons / next_blocker / next_action
 *
 * 不写库、不读库、不调网络。100% 纯函数，便于单测。
 */

import {
  CRITICAL_STEP_KEYS,
  SHIPMENT_STEP_KEYS,
  isCriticalStep,
  isShipmentStep,
} from './criticalNodes';
import type {
  ConfidenceComputeInput,
  ConfidenceComputeOutput,
  ConfidenceReason,
  ConfidenceExplain,
  NextBlocker,
  RuntimeRiskLevel,
} from './types';

// ─────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────

const DONE_STATUSES = new Set(['done', '已完成', 'completed']);
const BLOCKED_STATUSES = new Set(['blocked', '阻塞', '卡单', '卡住']);

function isDone(status: string | null | undefined): boolean {
  return !!status && DONE_STATUSES.has(status);
}

function isBlocked(status: string | null | undefined): boolean {
  return !!status && BLOCKED_STATUSES.has(status);
}

function daysBetween(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / 86400000);
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// 角色中文化（生成 next_action 文案用）
const ROLE_LABEL: Record<string, string> = {
  sales: '业务',
  merchandiser: '跟单',
  finance: '财务',
  procurement: '采购',
  production: '生产',
  production_manager: '生产主管',
  qc: 'QC',
  logistics: '物流',
  admin: '管理员',
  admin_assistant: '管理助理',
};

function roleZh(role: string | null | undefined): string {
  if (!role) return '负责人';
  return ROLE_LABEL[role] || role;
}

// ─────────────────────────────────────────────────────────────
// 找下一关键节点（next_blocker）
// ─────────────────────────────────────────────────────────────

export function findNextCriticalBlocker(
  milestones: any[],
  now: Date,
): NextBlocker | null {
  const undone = milestones
    .filter(m => !isDone(m.status) && CRITICAL_STEP_KEYS.has(m.step_key))
    .sort((a, b) => {
      const ax = a.sequence_number ?? 999;
      const bx = b.sequence_number ?? 999;
      if (ax !== bx) return ax - bx;
      const ad = a.due_at ? new Date(a.due_at).getTime() : Infinity;
      const bd = b.due_at ? new Date(b.due_at).getTime() : Infinity;
      return ad - bd;
    });
  const next = undone[0];
  if (!next) return null;

  const due = next.due_at ? new Date(next.due_at).getTime() : null;
  const delta = due !== null ? Math.ceil((now.getTime() - due) / 86400000) : 0;

  return {
    step_key: next.step_key,
    name: next.name,
    due_at: next.due_at || null,
    status: next.status,
    owner_role: next.owner_role || null,
    daysOverdue: delta > 0 ? delta : 0,
    daysUntil: delta < 0 ? Math.abs(delta) : 0,
  };
}

// ─────────────────────────────────────────────────────────────
// 出货状态
// ─────────────────────────────────────────────────────────────

function isOrderShipped(milestones: any[]): boolean {
  return milestones.some(m => SHIPMENT_STEP_KEYS.has(m.step_key) && isDone(m.status));
}

// 是否所有未完成节点都被批准的延期覆盖（用于"buffer 够"判断）
function hasApprovedDelayCovering(
  milestoneId: string,
  delayRequests: any[] | undefined,
  now: Date,
): boolean {
  if (!delayRequests || delayRequests.length === 0) return false;
  const approved = delayRequests.filter(d =>
    d.milestone_id === milestoneId && d.status === 'approved'
  );
  if (approved.length === 0) return false;
  // 如果批准的延期把 due_at 推到了未来，认为已被覆盖
  return approved.some(d => {
    const target = d.proposed_new_due_at || d.proposed_new_anchor_date;
    if (!target) return false;
    return new Date(target).getTime() > now.getTime();
  });
}

function hasPendingDelayRequest(milestoneId: string, delayRequests: any[] | undefined): boolean {
  if (!delayRequests) return false;
  return delayRequests.some(d => d.milestone_id === milestoneId && d.status === 'pending');
}

// ─────────────────────────────────────────────────────────────
// 主入口
// ─────────────────────────────────────────────────────────────

export function computeDeliveryConfidence(
  input: ConfidenceComputeInput,
): ConfidenceComputeOutput {
  const now = input.now || new Date();
  const order = input.order;
  const milestones = input.milestones || [];
  const financials = input.financials;
  const delays = input.delayRequests || [];

  let score = 100;
  const reasons: ConfidenceReason[] = [];

  const factoryDate: Date | null = order.factory_date ? new Date(order.factory_date) : null;
  const remainingDays = factoryDate ? daysBetween(factoryDate, now) : null;
  const shipped = isOrderShipped(milestones);
  const allDone = milestones.length > 0 && milestones.every(m => isDone(m.status));

  // ─── A. 已完成 / 已出运分支（不算排期风险，看付款）
  if (allDone || shipped) {
    return computeShippedOrCompleted({ shipped, allDone, financials, milestones, now });
  }

  // ─── B. 关键节点扣分
  const undoneCritical = milestones.filter(
    m => !isDone(m.status) && isCriticalStep(m.step_key),
  );

  // 收集"普通超期"的关键节点（blocked / 已批延期单独立刻扣分）
  const overdueCriticals: Array<{ m: any; days: number; baseHit: number }> = [];

  for (const m of undoneCritical) {
    const due = m.due_at ? new Date(m.due_at) : null;
    const overdueDays = due ? daysBetween(now, due) : 0;
    const blocked = isBlocked(m.status);
    const coveredByDelay = hasApprovedDelayCovering(m.id, delays, now);
    const pendingDelay = hasPendingDelayRequest(m.id, delays);

    // blocked + 无审批方案 → 必须强力扣分（且后面会强制 cap < 50）
    if (blocked && !coveredByDelay && !pendingDelay) {
      reasons.push({
        code: 'critical_blocked_no_resolution',
        label: `关键节点【${m.name}】被卡住且无延期申请`,
        delta: -35,
        weight: 'critical',
      });
      score -= 35;
      continue;
    }
    if (blocked && pendingDelay) {
      reasons.push({
        code: 'critical_blocked_pending_approval',
        label: `关键节点【${m.name}】被卡住，延期申请待审批`,
        delta: -15,
        weight: 'high',
      });
      score -= 15;
      continue;
    }

    if (coveredByDelay) {
      reasons.push({
        code: 'critical_delayed_but_approved',
        label: `关键节点【${m.name}】延期已批准（缓冲消耗中）`,
        delta: -3,
        weight: 'low',
      });
      score -= 3;
      continue;
    }

    // 关键节点超期（无延期处理）→ 收集后递减叠加
    if (overdueDays > 0) {
      let baseHit = 0;
      if (overdueDays >= 8)      baseHit = 30;
      else if (overdueDays >= 3) baseHit = 20;
      else                       baseHit = 10;
      overdueCriticals.push({ m, days: overdueDays, baseHit });
    }
  }

  // 递减叠加：worst 100% / 2nd 50% / 3rd 25% / 4th 15% / 5th+ 10%；类别总封顶 -50
  // 同根因往往导致多个关键节点同时 stuck，避免指数化惩罚
  overdueCriticals.sort((a, b) => b.baseHit - a.baseHit || b.days - a.days);
  const STACK_FACTORS = [1.0, 0.5, 0.25, 0.15, 0.1];
  const CRITICAL_OVERDUE_CAP = 50;
  let criticalOverdueTotal = 0;
  for (let i = 0; i < overdueCriticals.length; i++) {
    const { m, days, baseHit } = overdueCriticals[i];
    const factor = STACK_FACTORS[Math.min(i, STACK_FACTORS.length - 1)];
    let delta = -Math.round(baseHit * factor);
    // 类别封顶：单一类别总扣分 ≤ -50
    if (-criticalOverdueTotal + -delta > CRITICAL_OVERDUE_CAP) {
      delta = -(CRITICAL_OVERDUE_CAP - (-criticalOverdueTotal));
    }
    if (delta === 0) break;
    criticalOverdueTotal += delta;
    const weight: ConfidenceReason['weight'] =
      i === 0 ? (days >= 8 ? 'critical' : 'high') : (i <= 1 ? 'medium' : 'low');
    reasons.push({
      code: 'critical_step_overdue',
      label: i === 0
        ? `关键节点【${m.name}】已超期 ${days} 天`
        : `叠加：【${m.name}】超期 ${days} 天（递减计入）`,
      delta,
      weight,
    });
    score += delta;
  }

  // ─── C. 非关键节点超期（小幅扣分，封顶 -10）
  const undoneNonCritical = milestones.filter(
    m => !isDone(m.status) && !isCriticalStep(m.step_key),
  );
  let nonCriticalOverdueCount = 0;
  for (const m of undoneNonCritical) {
    const due = m.due_at ? new Date(m.due_at) : null;
    const overdueDays = due ? daysBetween(now, due) : 0;
    if (overdueDays > 0 && !isBlocked(m.status)) nonCriticalOverdueCount++;
  }
  if (nonCriticalOverdueCount > 0) {
    const delta = Math.max(-10, -3 * nonCriticalOverdueCount);
    reasons.push({
      code: 'noncritical_overdue',
      label: `${nonCriticalOverdueCount} 个非关键节点超期（影响小）`,
      delta,
      weight: 'low',
    });
    score += delta;
  }

  // ─── D. 出厂日已过但货物未出
  // 注意：和"工厂完成超期"高度重合，已扣分时减弱权重避免双计
  if (factoryDate && remainingDays !== null && remainingDays < 0) {
    const overByDays = Math.abs(remainingDays);
    let baseFD = overByDays >= 7 ? 15 : 10;
    if (criticalOverdueTotal < 0) {
      // 已经因关键节点超期扣过分 → 此处只追加 40% 权重
      baseFD = Math.round(baseFD * 0.4);
    }
    if (baseFD > 0) {
      reasons.push({
        code: 'factory_date_passed',
        label: `出厂日已过 ${overByDays} 天，货物未出运`,
        delta: -baseFD,
        weight: criticalOverdueTotal < 0 ? 'medium' : 'high',
      });
      score -= baseFD;
    }
  }
  // ─── E. 临近出厂日 + 还有关键工作未完成
  else if (factoryDate && remainingDays !== null && undoneCritical.length > 0) {
    if (remainingDays <= 3) {
      reasons.push({
        code: 'tight_buffer',
        label: `仅剩 ${remainingDays} 天出厂，关键工作未完成`,
        delta: -15,
        weight: 'high',
      });
      score -= 15;
    } else if (remainingDays <= 7) {
      reasons.push({
        code: 'tight_buffer',
        label: `剩 ${remainingDays} 天出厂，关键工作未完成`,
        delta: -8,
        weight: 'medium',
      });
      score -= 8;
    } else if (remainingDays <= 14) {
      reasons.push({
        code: 'medium_buffer',
        label: `剩 ${remainingDays} 天出厂，需关注关键节点`,
        delta: -3,
        weight: 'low',
      });
      score -= 3;
    }
  }

  // ─── F. 确认链不全 + 时间紧
  if (financials) {
    const conf = financials.confirmation_completion_rate;
    const missing = financials.missing_confirmations;
    if (typeof conf === 'number' && conf < 1 && remainingDays !== null && remainingDays <= 14) {
      reasons.push({
        code: 'confirmations_incomplete',
        label: `确认链未齐${missing && missing.length > 0 ? `（${missing.slice(0, 2).join('、')}…）` : ''}，临近出厂`,
        delta: -8,
        weight: 'medium',
      });
      score -= 8;
    }
  }

  // 硬上限：任何关键节点 blocked + 无方案 → 必须 red（< 50）
  const hasUnresolvedBlocker = reasons.some(r => r.code === 'critical_blocked_no_resolution');
  if (hasUnresolvedBlocker && score >= 50) {
    score = 49;
  }

  // 钳制
  score = Math.max(0, Math.min(100, score));

  // ─── 构造 explain
  const blocker = findNextCriticalBlocker(milestones, now);
  const riskLevel = scoreToRisk(score);
  const headline = buildHeadline(score, riskLevel);
  const nextAction = buildNextAction(blocker, score, remainingDays, shipped);

  // 排序 reasons：扣分最大的在前
  reasons.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const explain: ConfidenceExplain = {
    headline,
    reasons,
    next_blocker: blocker,
    next_action: nextAction,
    computed_at: now.toISOString(),
  };

  // ─── 推算 predicted_finish_date
  const predicted = predictFinishDate(milestones, factoryDate, now);

  return {
    confidence: score,
    riskLevel,
    predictedFinishDate: predicted ? ymd(predicted) : null,
    bufferDays: remainingDays,
    explain,
  };
}

// ─────────────────────────────────────────────────────────────
// 已出运 / 已完成分支
// ─────────────────────────────────────────────────────────────

function computeShippedOrCompleted(args: {
  shipped: boolean;
  allDone: boolean;
  financials: any;
  milestones: any[];
  now: Date;
}): ConfidenceComputeOutput {
  const { shipped, allDone, financials, milestones, now } = args;
  const reasons: ConfidenceReason[] = [];
  let score = 95; // 基线高（货物在路上 / 已交付）

  // 付款情况
  const balanceStatus = financials?.balance_status; // received / partial / pending / overdue
  const depositStatus = financials?.deposit_status;

  if (balanceStatus === 'overdue') {
    reasons.push({ code: 'balance_overdue', label: '客户尾款逾期未收', delta: -25, weight: 'high' });
    score -= 25;
  } else if (balanceStatus === 'pending' || balanceStatus === 'partial') {
    reasons.push({ code: 'balance_pending', label: '客户尾款待收', delta: -10, weight: 'medium' });
    score -= 10;
  }
  if (depositStatus === 'pending') {
    reasons.push({ code: 'deposit_pending', label: '定金未收', delta: -10, weight: 'medium' });
    score -= 10;
  }

  score = Math.max(0, Math.min(100, score));
  const riskLevel = scoreToRisk(score);

  // 标题：货物在外 / 客户付款未收齐 → "已出运"；
  //       全部交付 + 收款齐 → "订单已完成"
  const balanceFinal = financials?.balance_status === 'received';
  const fullyClosed = allDone && balanceFinal;
  const headline = fullyClosed
    ? buildHeadline(score, riskLevel, '订单已完成')
    : buildHeadline(score, riskLevel, '货物已出运');

  // next_action：出货后的关注点
  let nextAction: string | null = null;
  if (balanceStatus === 'overdue') {
    nextAction = '财务/业务立即跟进客户尾款';
  } else if (balanceStatus === 'pending' || balanceStatus === 'partial') {
    nextAction = '业务跟进客户出货后尾款时间';
  } else if (depositStatus === 'pending') {
    nextAction = '业务跟进定金到账';
  }

  return {
    confidence: score,
    riskLevel,
    predictedFinishDate: null,
    bufferDays: null,
    explain: {
      headline,
      reasons,
      next_blocker: null,
      next_action: nextAction,
      computed_at: now.toISOString(),
    },
  };
}

// ─────────────────────────────────────────────────────────────
// 等级 / 文案 / 预测
// ─────────────────────────────────────────────────────────────

function scoreToRisk(score: number): RuntimeRiskLevel {
  if (score >= 85) return 'green';
  if (score >= 70) return 'yellow';
  if (score >= 50) return 'orange';
  return 'red';
}

function buildHeadline(score: number, level: RuntimeRiskLevel, context?: string): string {
  const emoji = { green: '🟢', yellow: '🟡', orange: '🟠', red: '🔴', gray: '⚪' }[level];
  // 文案原则：温和、不刺激情绪，让员工看到觉得"系统在帮我"
  const verbal: Record<RuntimeRiskLevel, string> = {
    green:  '准时交付',
    yellow: '交付有压力',
    orange: '交付需关注',
    red:    '交付风险高',
    gray:   '数据不足',
  };
  const ctx = context ? `（${context}）` : '';
  return `${emoji} ${verbal[level]}（${score}%）${ctx}`;
}

function buildNextAction(
  blocker: NextBlocker | null,
  score: number,
  remainingDays: number | null,
  shipped: boolean,
): string | null {
  if (shipped) return null; // 出货分支已设置
  if (!blocker) {
    if (score >= 85) return '保持节奏，定期复核';
    return null;
  }

  const role = roleZh(blocker.owner_role);

  if (isBlocked(blocker.status)) {
    return `${role}先解除【${blocker.name}】阻塞；如需延期请提交合理日期供审批`;
  }
  if (blocker.daysOverdue >= 7) {
    return `${role}立即推进【${blocker.name}】，或提交延期申请并写明原因`;
  }
  if (blocker.daysOverdue > 0) {
    return `${role}尽快完成【${blocker.name}】（已超 ${blocker.daysOverdue} 天）`;
  }
  if (remainingDays !== null && remainingDays <= 7) {
    return `时间紧，${role}盯紧【${blocker.name}】交付`;
  }
  return `${role}按计划推进【${blocker.name}】`;
}

/**
 * 简单预测完工日：取最晚未完成节点的 due_at；如果有已超期节点，预测往后移
 * Phase 1 不做完整 forward pass，只做粗略估算
 */
function predictFinishDate(milestones: any[], factoryDate: Date | null, now: Date): Date | null {
  if (!factoryDate) return null;
  const undone = milestones.filter(m => !isDone(m.status) && m.due_at);
  if (undone.length === 0) return factoryDate;

  // 找最晚的 due_at
  let latest: Date = factoryDate;
  let maxOverdue = 0;
  for (const m of undone) {
    const due = new Date(m.due_at);
    if (due > latest) latest = due;
    if (isCriticalStep(m.step_key)) {
      const od = daysBetween(now, due);
      if (od > maxOverdue) maxOverdue = od;
    }
  }
  // 如果有关键节点已超期，预测完工日往后顺延同等天数
  if (maxOverdue > 0) {
    return new Date(latest.getTime() + maxOverdue * 86400000);
  }
  return latest;
}
