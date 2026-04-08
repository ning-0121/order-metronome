/**
 * SystemGuardian — 每晚凌晨跑的"系统管家"
 *
 * 覆盖 6 个维度：
 *   1. security      — 安全性（孤立数据、未授权访问、敏感字段泄漏）
 *   2. stability     — 稳定性（卡死状态、孤儿记录、熔断状态）
 *   3. metronome     — 节拍器准确性（节点日期异常、排序错乱）
 *   4. time          — 时间准确性（时区、节假日判定、日期一致性）
 *   5. permission    — 权限稳定性（角色分配、RLS、孤儿 profile）
 *   6. ai_evolution  — AI 进化稳定性（熔断、Skill 运行成功率、shadow 状态）
 *
 * 每个检查输出：
 *   - passed: 是否通过
 *   - severity: 严重度
 *   - message: 给人看的一句话
 *   - details: 具体数字 / 受影响的 ID 列表
 *   - auto_fixed: 是否已自动修复
 *
 * 最终结果写入 system_health_reports 表 + 通知管理员。
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type GuardianCategory =
  | 'security'
  | 'stability'
  | 'metronome'
  | 'time'
  | 'permission'
  | 'ai_evolution';

export type GuardianSeverity = 'ok' | 'info' | 'warning' | 'critical';

export interface CheckResult {
  id: string;
  category: GuardianCategory;
  title: string;
  passed: boolean;
  severity: GuardianSeverity;
  message: string;
  details?: Record<string, any>;
  auto_fixed?: boolean;
  auto_fix_note?: string;
}

export interface GuardianReport {
  ranAt: string;
  tookMs: number;
  totalChecks: number;
  passedCount: number;
  warningCount: number;
  criticalCount: number;
  autoFixedCount: number;
  checks: CheckResult[];
  /** AI 元审视层输出（可选） */
  metaReview?: {
    summary: string;
    concerns: string[];
    trends: string[];
    recommended_actions: string[];
  } | null;
}

// ════════════════════════════════════════════════════════
// 1. 安全性检查
// ════════════════════════════════════════════════════════

async function checkOrphanedProfiles(supabase: SupabaseClient): Promise<CheckResult> {
  // profiles 表有行但没有 email（异常）
  const { data, count } = await (supabase.from('profiles') as any)
    .select('user_id, email', { count: 'exact' })
    .is('email', null);
  const bad = count || 0;
  return {
    id: 'orphan_profiles_no_email',
    category: 'security',
    title: '无邮箱 profile',
    passed: bad === 0,
    severity: bad === 0 ? 'ok' : bad > 5 ? 'warning' : 'info',
    message: bad === 0 ? '✅ 所有用户档案都有邮箱' : `⚠ 发现 ${bad} 个没有邮箱的 profile`,
    details: { count: bad, samples: (data || []).slice(0, 5) },
  };
}

async function checkUsersWithoutRoles(supabase: SupabaseClient): Promise<CheckResult> {
  const { data } = await (supabase.from('profiles') as any)
    .select('user_id, email, role, roles');
  const profiles = (data || []) as any[];
  const noRole = profiles.filter(p => {
    const rolesArr = Array.isArray(p.roles) ? p.roles : [];
    return rolesArr.length === 0 && !p.role;
  });
  return {
    id: 'users_without_roles',
    category: 'security',
    title: '未分配角色的用户',
    passed: noRole.length === 0,
    severity: noRole.length === 0 ? 'ok' : 'warning',
    message:
      noRole.length === 0
        ? '✅ 所有用户都分配了角色'
        : `⚠ ${noRole.length} 个用户没有任何角色（无法执行任何操作）`,
    details: { count: noRole.length, emails: noRole.map(p => p.email).slice(0, 10) },
  };
}

async function checkOrphanedAttachments(
  supabase: SupabaseClient,
): Promise<CheckResult> {
  // order_attachments 引用的 order_id 在 orders 表不存在
  // 通过 LEFT JOIN 检查 — 用两次查询实现
  const { data: allAtts } = await (supabase.from('order_attachments') as any)
    .select('id, order_id')
    .limit(500);
  const attIds = (allAtts || []) as any[];
  const orderIdSet = new Set(attIds.map(a => a.order_id).filter(Boolean));
  if (orderIdSet.size === 0) {
    return {
      id: 'orphan_attachments',
      category: 'security',
      title: '孤儿附件',
      passed: true,
      severity: 'ok',
      message: '✅ 无孤儿附件',
    };
  }
  const { data: existingOrders } = await (supabase.from('orders') as any)
    .select('id')
    .in('id', Array.from(orderIdSet));
  const existingSet = new Set(((existingOrders || []) as any[]).map(o => o.id));
  const orphans = attIds.filter(a => !existingSet.has(a.order_id));
  return {
    id: 'orphan_attachments',
    category: 'security',
    title: '孤儿附件',
    passed: orphans.length === 0,
    severity: orphans.length === 0 ? 'ok' : orphans.length > 10 ? 'warning' : 'info',
    message:
      orphans.length === 0
        ? '✅ 无孤儿附件'
        : `⚠ ${orphans.length} 个附件引用了不存在的订单（样本中）`,
    details: { count: orphans.length, sampled: 500 },
  };
}

// ════════════════════════════════════════════════════════
// 2. 稳定性检查
// ════════════════════════════════════════════════════════

async function checkStuckAgentActions(
  supabase: SupabaseClient,
  autoFix: boolean,
): Promise<CheckResult> {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: stuck } = await (supabase.from('agent_actions') as any)
    .select('id')
    .eq('status', 'executing')
    .lt('created_at', cutoff);
  const stuckList = (stuck || []) as any[];
  let autoFixed = false;
  if (stuckList.length > 0 && autoFix) {
    await (supabase.from('agent_actions') as any)
      .update({ status: 'pending' })
      .eq('status', 'executing')
      .lt('created_at', cutoff);
    autoFixed = true;
  }
  return {
    id: 'stuck_agent_actions',
    category: 'stability',
    title: '卡住的 Agent 动作',
    passed: stuckList.length === 0,
    severity: stuckList.length === 0 ? 'ok' : 'warning',
    message:
      stuckList.length === 0
        ? '✅ 无卡住的 Agent 动作'
        : `⚠ ${stuckList.length} 个 Agent 动作卡在 executing >10min`,
    details: { count: stuckList.length },
    auto_fixed: autoFixed,
    auto_fix_note: autoFixed ? '已回退到 pending 状态' : undefined,
  };
}

async function checkMilestonesWithoutOwner(
  supabase: SupabaseClient,
): Promise<CheckResult> {
  const { data: milestones } = await (supabase.from('milestones') as any)
    .select('id, name, owner_role, order_id')
    .in('status', ['in_progress', '进行中'])
    .is('owner_user_id', null);
  const list = (milestones || []) as any[];
  return {
    id: 'milestones_without_owner',
    category: 'stability',
    title: '进行中节点无负责人',
    passed: list.length === 0,
    severity: list.length === 0 ? 'ok' : list.length > 10 ? 'critical' : 'warning',
    message:
      list.length === 0
        ? '✅ 所有进行中节点都有负责人'
        : `⚠ ${list.length} 个进行中节点无负责人（卡死风险）`,
    details: {
      count: list.length,
      roleBreakdown: list.reduce((acc, m) => {
        acc[m.owner_role] = (acc[m.owner_role] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
    },
  };
}

async function checkStaleCompletedOrders(
  supabase: SupabaseClient,
  autoFix: boolean,
): Promise<CheckResult> {
  // 所有节点都 done 但订单 lifecycle_status 还是"执行中"
  const { data: activeOrders } = await (supabase.from('orders') as any)
    .select('id, order_no')
    .in('lifecycle_status', ['执行中', 'running', 'active', '已生效']);
  const activeList = (activeOrders || []) as any[];
  const stale: any[] = [];

  for (const order of activeList) {
    const { data: ms } = await (supabase.from('milestones') as any)
      .select('status')
      .eq('order_id', order.id);
    if (ms && ms.length > 0) {
      const allDone = ms.every(
        (m: any) => m.status === 'done' || m.status === '已完成' || m.status === 'completed',
      );
      if (allDone) stale.push(order);
    }
  }

  let autoFixed = false;
  if (stale.length > 0 && autoFix) {
    await (supabase.from('orders') as any)
      .update({ lifecycle_status: '已完成' })
      .in(
        'id',
        stale.map(o => o.id),
      );
    autoFixed = true;
  }

  return {
    id: 'stale_completed_orders',
    category: 'stability',
    title: '应完成未标记的订单',
    passed: stale.length === 0,
    severity: stale.length === 0 ? 'ok' : 'info',
    message:
      stale.length === 0
        ? '✅ 订单状态与节点状态一致'
        : `⚠ ${stale.length} 个订单所有节点已完成但状态仍为执行中`,
    details: { count: stale.length, samples: stale.slice(0, 5).map(o => o.order_no) },
    auto_fixed: autoFixed,
    auto_fix_note: autoFixed ? '已自动标记为已完成' : undefined,
  };
}

// ════════════════════════════════════════════════════════
// 3. 节拍器准确性
// ════════════════════════════════════════════════════════

async function checkMilestonesBeforeOrderDate(
  supabase: SupabaseClient,
): Promise<CheckResult> {
  // 关键节拍器 bug：节点 due_at < 订单 order_date
  // 之前 ensureBusinessDay 时区 bug 就是这样爆出来的
  const { data: orders } = await (supabase.from('orders') as any)
    .select('id, order_no, order_date')
    .not('order_date', 'is', null)
    .not('status', 'in', '("completed","archived","cancelled","已完成","已归档","已取消")')
    .limit(500);

  const orderList = (orders || []) as any[];
  const bad: Array<{ order_no: string; step_key: string; due_at: string; order_date: string }> = [];

  for (const order of orderList) {
    const { data: ms } = await (supabase.from('milestones') as any)
      .select('step_key, due_at')
      .eq('order_id', order.id)
      .not('due_at', 'is', null);
    const orderTs = new Date(order.order_date + 'T00:00:00+08:00').getTime();
    for (const m of (ms || []) as any[]) {
      const mTs = new Date(m.due_at).getTime();
      if (mTs < orderTs - 86400000) {
        // 允许 1 天误差
        bad.push({
          order_no: order.order_no,
          step_key: m.step_key,
          due_at: String(m.due_at).slice(0, 10),
          order_date: order.order_date,
        });
      }
    }
  }

  return {
    id: 'milestones_before_order_date',
    category: 'metronome',
    title: '节点早于下单日',
    passed: bad.length === 0,
    severity: bad.length === 0 ? 'ok' : 'critical',
    message:
      bad.length === 0
        ? '✅ 所有节点 due_at 都不早于订单 order_date'
        : `🔴 ${bad.length} 个节点的 due_at 早于订单 order_date（排期计算错误）`,
    details: { count: bad.length, samples: bad.slice(0, 10) },
  };
}

async function checkFactoryDateBeforeOrderDate(
  supabase: SupabaseClient,
): Promise<CheckResult> {
  const { data: bad } = await (supabase.from('orders') as any)
    .select('id, order_no, order_date, factory_date')
    .not('order_date', 'is', null)
    .not('factory_date', 'is', null)
    .not('status', 'in', '("completed","archived","cancelled","已完成","已归档","已取消")');

  const badList = ((bad || []) as any[]).filter(
    o => o.factory_date < o.order_date,
  );

  return {
    id: 'factory_date_before_order_date',
    category: 'metronome',
    title: '出厂日早于下单日',
    passed: badList.length === 0,
    severity: badList.length === 0 ? 'ok' : 'critical',
    message:
      badList.length === 0
        ? '✅ 所有订单出厂日都 ≥ 下单日'
        : `🔴 ${badList.length} 个订单出厂日早于下单日（不可能发生）`,
    details: { count: badList.length, samples: badList.slice(0, 5).map(o => o.order_no) },
  };
}

async function checkActiveOrdersWithoutDueAt(
  supabase: SupabaseClient,
): Promise<CheckResult> {
  const { data: noDueAt } = await (supabase.from('milestones') as any)
    .select('id, order_id, step_key, status')
    .in('status', ['in_progress', '进行中'])
    .is('due_at', null);
  const list = (noDueAt || []) as any[];
  return {
    id: 'active_milestones_without_due_at',
    category: 'metronome',
    title: '进行中节点没有 due_at',
    passed: list.length === 0,
    severity: list.length === 0 ? 'ok' : 'warning',
    message:
      list.length === 0
        ? '✅ 所有进行中节点都有截止日'
        : `⚠ ${list.length} 个进行中节点缺截止日`,
    details: { count: list.length },
  };
}

// ════════════════════════════════════════════════════════
// 4. 时间准确性
// ════════════════════════════════════════════════════════

async function checkServerTimezone(): Promise<CheckResult> {
  // 确认 isNonWorkday 对 2026 清明节判断正确
  // 这个检查是纯 JS，不依赖 DB
  const { default: dateUtils } = await import('@/lib/utils/date');
  // 用已知的非工作日测试
  // 2026-01-01 元旦（周四）— 应该是 non-workday
  const testDates: Array<{ date: string; expected: boolean; label: string }> = [
    { date: '2026-01-01', expected: true, label: '元旦' },
    { date: '2026-04-05', expected: true, label: '清明节' },
    { date: '2026-04-08', expected: false, label: '清明节后工作日' },
    { date: '2026-10-01', expected: true, label: '国庆' },
  ];

  const failures: string[] = [];
  // 只能通过 ensureBusinessDay 间接测试
  try {
    const { ensureBusinessDay } = await import('@/lib/utils/date');
    for (const t of testDates) {
      const d = new Date(t.date + 'T00:00:00+08:00');
      const result = ensureBusinessDay(d);
      const resultBj = new Date(result.getTime() + 8 * 3600 * 1000)
        .toISOString()
        .slice(0, 10);
      // 节假日应该被回退，工作日不变
      if (t.expected && resultBj === t.date) {
        failures.push(`${t.label}(${t.date}) 应该回退但没回退`);
      }
      if (!t.expected && resultBj !== t.date) {
        failures.push(`${t.label}(${t.date}) 不该回退但被回退到 ${resultBj}`);
      }
    }
  } catch (e: any) {
    failures.push(`ensureBusinessDay 调用失败: ${e?.message}`);
  }

  return {
    id: 'timezone_and_holidays',
    category: 'time',
    title: '时区 + 节假日判定',
    passed: failures.length === 0,
    severity: failures.length === 0 ? 'ok' : 'critical',
    message:
      failures.length === 0
        ? '✅ 时区与节假日判定正常（已验证 4 个已知日期）'
        : `🔴 时区或节假日判定异常：${failures.length} 个用例失败`,
    details: { failures, testedCount: testDates.length },
  };
}

async function checkRecentOrdersDatesIntegrity(
  supabase: SupabaseClient,
): Promise<CheckResult> {
  // 检查最近 30 天创建的订单：created_at 应该在合理范围（不能是未来/远古）
  const { data } = await (supabase.from('orders') as any)
    .select('id, order_no, created_at, order_date')
    .gte('created_at', new Date(Date.now() - 30 * 86400000).toISOString())
    .limit(500);
  const now = Date.now();
  const bad: string[] = [];
  for (const o of (data || []) as any[]) {
    const ts = new Date(o.created_at).getTime();
    if (ts > now + 3600000) bad.push(`${o.order_no}: created_at 在未来`);
    if (ts < now - 365 * 86400000 * 10) bad.push(`${o.order_no}: created_at 在 10 年前`);
  }
  return {
    id: 'recent_orders_dates_integrity',
    category: 'time',
    title: '最近订单时间戳合理性',
    passed: bad.length === 0,
    severity: bad.length === 0 ? 'ok' : 'warning',
    message: bad.length === 0 ? '✅ 最近 30 天订单时间戳正常' : `⚠ ${bad.length} 个异常`,
    details: { samples: bad.slice(0, 10) },
  };
}

// ════════════════════════════════════════════════════════
// 5. 权限稳定性
// ════════════════════════════════════════════════════════

async function checkAdminCount(supabase: SupabaseClient): Promise<CheckResult> {
  const { data: all } = await (supabase.from('profiles') as any)
    .select('user_id, email, role, roles');
  const admins = ((all || []) as any[]).filter(p => {
    const arr = Array.isArray(p.roles) ? p.roles : [];
    return arr.includes('admin') || p.role === 'admin';
  });

  const count = admins.length;
  let severity: GuardianSeverity = 'ok';
  let message = `✅ 系统有 ${count} 个管理员`;
  if (count === 0) {
    severity = 'critical';
    message = '🔴 系统没有任何管理员！无法管理';
  } else if (count === 1) {
    severity = 'warning';
    message = `⚠ 只有 1 个管理员 — 单点风险，建议至少 2 个`;
  } else if (count > 5) {
    severity = 'warning';
    message = `⚠ 管理员过多 (${count} 个)，可能有安全风险`;
  }

  return {
    id: 'admin_count',
    category: 'permission',
    title: '管理员数量',
    passed: count >= 1 && count <= 5,
    severity,
    message,
    details: { count, emails: admins.map((a: any) => a.email) },
  };
}

async function checkRoleDistribution(
  supabase: SupabaseClient,
): Promise<CheckResult> {
  const { data: all } = await (supabase.from('profiles') as any)
    .select('role, roles');
  const counter: Record<string, number> = {};
  for (const p of (all || []) as any[]) {
    const arr = Array.isArray(p.roles) && p.roles.length > 0 ? p.roles : p.role ? [p.role] : [];
    for (const r of arr) counter[r] = (counter[r] || 0) + 1;
  }
  const criticalRoles = ['sales', 'merchandiser', 'finance', 'procurement'];
  const missing = criticalRoles.filter(r => !counter[r]);
  return {
    id: 'role_distribution',
    category: 'permission',
    title: '关键角色覆盖',
    passed: missing.length === 0,
    severity: missing.length === 0 ? 'ok' : 'warning',
    message:
      missing.length === 0
        ? `✅ 所有关键角色都有人（${criticalRoles.map(r => `${r}:${counter[r] || 0}`).join(', ')}）`
        : `⚠ 缺少关键角色：${missing.join('、')}`,
    details: { counter, missing },
  };
}

// ════════════════════════════════════════════════════════
// 6. AI 进化稳定性
// ════════════════════════════════════════════════════════

async function checkSkillCircuitBreakers(
  supabase: SupabaseClient,
): Promise<CheckResult> {
  try {
    const { data } = await (supabase.from('ai_skill_circuit_state') as any).select('*');
    const states = (data || []) as any[];
    const paused = states.filter(s => s.paused_until && new Date(s.paused_until) > new Date());
    return {
      id: 'skill_circuit_breakers',
      category: 'ai_evolution',
      title: 'Skill 熔断状态',
      passed: paused.length === 0,
      severity: paused.length === 0 ? 'ok' : 'warning',
      message:
        paused.length === 0
          ? '✅ 所有 Skill 运行正常'
          : `⚠ ${paused.length} 个 Skill 被熔断：${paused.map(p => p.skill_name).join('、')}`,
      details: {
        paused: paused.map(p => ({ skill: p.skill_name, reason: p.last_failure_message })),
        total: states.length,
      },
    };
  } catch {
    return {
      id: 'skill_circuit_breakers',
      category: 'ai_evolution',
      title: 'Skill 熔断状态',
      passed: true,
      severity: 'info',
      message: 'ℹ️ ai_skill_circuit_state 表未建立或为空',
    };
  }
}

async function checkSkillRunSuccessRate(
  supabase: SupabaseClient,
): Promise<CheckResult> {
  try {
    const since = new Date(Date.now() - 24 * 3600000).toISOString();
    const { data } = await (supabase.from('ai_skill_runs') as any)
      .select('skill_name, status')
      .gte('started_at', since);
    const runs = (data || []) as any[];
    if (runs.length === 0) {
      return {
        id: 'skill_success_rate',
        category: 'ai_evolution',
        title: 'Skill 24h 运行成功率',
        passed: true,
        severity: 'info',
        message: 'ℹ️ 过去 24h 没有 Skill 运行记录',
      };
    }
    const bySkill: Record<string, { total: number; failed: number }> = {};
    for (const r of runs) {
      if (!bySkill[r.skill_name]) bySkill[r.skill_name] = { total: 0, failed: 0 };
      bySkill[r.skill_name].total++;
      if (r.status === 'failed' || r.status === 'timeout') bySkill[r.skill_name].failed++;
    }
    const lowRate: string[] = [];
    for (const [skill, { total, failed }] of Object.entries(bySkill)) {
      const rate = ((total - failed) / total) * 100;
      if (rate < 80) lowRate.push(`${skill}(${rate.toFixed(0)}%)`);
    }
    return {
      id: 'skill_success_rate',
      category: 'ai_evolution',
      title: 'Skill 24h 运行成功率',
      passed: lowRate.length === 0,
      severity: lowRate.length === 0 ? 'ok' : 'warning',
      message:
        lowRate.length === 0
          ? `✅ 所有 Skill 成功率 ≥ 80%（${runs.length} 次运行）`
          : `⚠ 低成功率 Skill：${lowRate.join('、')}`,
      details: { bySkill, totalRuns: runs.length },
    };
  } catch {
    return {
      id: 'skill_success_rate',
      category: 'ai_evolution',
      title: 'Skill 24h 运行成功率',
      passed: true,
      severity: 'info',
      message: 'ℹ️ ai_skill_runs 表未建立',
    };
  }
}

// ════════════════════════════════════════════════════════
// 主入口：跑所有检查
// ════════════════════════════════════════════════════════

export async function runSystemGuardian(
  supabase: SupabaseClient,
  opts: { autoFix?: boolean; withMetaReview?: boolean } = {},
): Promise<GuardianReport> {
  const startedAt = Date.now();
  const autoFix = opts.autoFix ?? true;

  // 按类别跑所有检查（并行同类，顺序不同类）
  const checks: CheckResult[] = [];

  // 1. security
  checks.push(
    ...(await Promise.all([
      checkOrphanedProfiles(supabase),
      checkUsersWithoutRoles(supabase),
      checkOrphanedAttachments(supabase),
    ])),
  );

  // 2. stability
  checks.push(
    ...(await Promise.all([
      checkStuckAgentActions(supabase, autoFix),
      checkMilestonesWithoutOwner(supabase),
      checkStaleCompletedOrders(supabase, autoFix),
    ])),
  );

  // 3. metronome
  checks.push(
    ...(await Promise.all([
      checkMilestonesBeforeOrderDate(supabase),
      checkFactoryDateBeforeOrderDate(supabase),
      checkActiveOrdersWithoutDueAt(supabase),
    ])),
  );

  // 4. time
  checks.push(
    ...(await Promise.all([checkServerTimezone(), checkRecentOrdersDatesIntegrity(supabase)])),
  );

  // 5. permission
  checks.push(
    ...(await Promise.all([checkAdminCount(supabase), checkRoleDistribution(supabase)])),
  );

  // 6. ai_evolution
  checks.push(
    ...(await Promise.all([
      checkSkillCircuitBreakers(supabase),
      checkSkillRunSuccessRate(supabase),
    ])),
  );

  // 统计
  const passedCount = checks.filter(c => c.passed).length;
  const warningCount = checks.filter(c => c.severity === 'warning').length;
  const criticalCount = checks.filter(c => c.severity === 'critical').length;
  const autoFixedCount = checks.filter(c => c.auto_fixed).length;

  // AI 元审视层（可选）
  let metaReview: GuardianReport['metaReview'] = null;
  if (opts.withMetaReview) {
    metaReview = await generateMetaReview(checks);
  }

  return {
    ranAt: new Date().toISOString(),
    tookMs: Date.now() - startedAt,
    totalChecks: checks.length,
    passedCount,
    warningCount,
    criticalCount,
    autoFixedCount,
    checks,
    metaReview,
  };
}

// ════════════════════════════════════════════════════════
// AI 元审视层：让 Claude Sonnet 读所有检查结果，给出人类视角的总结
// ════════════════════════════════════════════════════════

async function generateMetaReview(
  checks: CheckResult[],
): Promise<GuardianReport['metaReview']> {
  try {
    const { callClaudeJSON } = await import('@/lib/agent/anthropicClient');
    const failed = checks.filter(c => !c.passed);
    if (failed.length === 0) {
      return {
        summary: '系统全面健康，所有检查通过',
        concerns: [],
        trends: [],
        recommended_actions: [],
      };
    }

    const digest = failed
      .map(
        c =>
          `[${c.category}/${c.severity}] ${c.title}: ${c.message}${c.auto_fixed ? '（已自动修复）' : ''}`,
      )
      .join('\n');

    const prompt = `你是一个负责维护 SaaS 生产系统的高级 SRE。下面是系统管家今晚跑的检查结果中"未通过"的项目：

${digest}

请从以下角度分析，输出 JSON：
{
  "summary": "一句话总体判断",
  "concerns": ["最值得担心的 1-3 个问题（每条 20 字内）"],
  "trends": ["如果发现任何潜在趋势或系统性问题"],
  "recommended_actions": ["明确建议管理员要做的事（每条 30 字内）"]
}

规则：
- summary 要客观，不要过度悲观或乐观
- concerns 按影响面排序，critical 一定排前面
- 如果"已自动修复"的问题反复出现就是趋势，要写进 trends
- recommended_actions 要具体到动作（"检查 X"、"打开 /admin/Y 页面"），不要空泛`;

    const result = await callClaudeJSON<GuardianReport['metaReview']>({
      scene: 'system_guardian_meta',
      model: 'claude-sonnet-4-20250514',
      prompt,
      maxTokens: 800,
      timeoutMs: 25000,
    });
    return result;
  } catch (e: any) {
    console.error('[systemGuardian] meta review failed:', e?.message);
    return null;
  }
}

// ════════════════════════════════════════════════════════
// 格式化为文本报告（微信推送/通知用）
// ════════════════════════════════════════════════════════

export function formatReportAsText(report: GuardianReport): string {
  const lines: string[] = [];
  lines.push(
    `🛡 系统守护报告 — ${new Date(report.ranAt).toLocaleDateString('zh-CN')}`,
  );
  lines.push('');
  lines.push(
    `通过 ${report.passedCount}/${report.totalChecks}｜⚠ 警告 ${report.warningCount}｜🔴 严重 ${report.criticalCount}｜🔧 自动修复 ${report.autoFixedCount}`,
  );
  lines.push('');

  if (report.metaReview) {
    lines.push('【AI 总结】');
    lines.push(report.metaReview.summary);
    if (report.metaReview.concerns.length > 0) {
      lines.push('关注：' + report.metaReview.concerns.join('、'));
    }
    if (report.metaReview.recommended_actions.length > 0) {
      lines.push('建议：');
      report.metaReview.recommended_actions.forEach(a => lines.push(`• ${a}`));
    }
    lines.push('');
  }

  const failed = report.checks.filter(c => !c.passed);
  if (failed.length > 0) {
    lines.push('【未通过的检查】');
    for (const c of failed) {
      lines.push(
        `${c.severity === 'critical' ? '🔴' : c.severity === 'warning' ? '⚠' : 'ℹ'} ${c.title}：${c.message}${c.auto_fixed ? '（已自动修复）' : ''}`,
      );
    }
  } else {
    lines.push('✅ 所有检查都通过');
  }

  return lines.join('\n');
}
