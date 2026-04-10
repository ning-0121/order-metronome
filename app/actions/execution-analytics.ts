'use server';

/**
 * 执行力看板 — 员工执行数据分析
 *
 * 数据来源：milestones + milestone_logs + notifications
 *
 * 指标体系：
 *   1. 完成数 — 该员工在时间段内完成的节点数
 *   2. 平均响应时间 — 从节点变为 in_progress 到 done 的平均天数
 *   3. 逾期率 — 逾期完成的节点 / 总完成节点
 *   4. 当前逾期数 — 现在手头逾期的节点数
 *   5. 升级次数 — 被自动升级链触发了几次（L2/L3 = 被上报）
 *   6. 执行力评分 — 综合加权 0-100
 */

import { createClient } from '@/lib/supabase/server';

export interface ExecutionScore {
  userId: string;
  name: string;
  email: string;
  roles: string[];
  roleLabel: string;
  // 完成指标
  completedCount: number;          // 完成节点数
  avgResponseDays: number;         // 平均响应天数
  fastestResponseDays: number;     // 最快响应
  slowestResponseDays: number;     // 最慢响应
  // 逾期指标
  overdueCompletedCount: number;   // 逾期完成数
  overdueRate: number;             // 逾期率 %
  currentOverdueCount: number;     // 当前逾期数
  totalOverdueDays: number;        // 当前逾期总天数
  // 升级指标
  escalationCount: number;         // 被升级次数（L2+L3）
  // 综合
  executionScore: number;          // 0-100
  grade: 'S' | 'A' | 'B' | 'C' | 'D';
  trend: 'up' | 'down' | 'stable'; // 和上期比较
}

export interface ExecutionSummary {
  rankings: ExecutionScore[];
  teamAvg: {
    avgResponseDays: number;
    overdueRate: number;
    executionScore: number;
  };
  period: string;
  generatedAt: string;
}

const ROLE_LABELS: Record<string, string> = {
  sales: '业务', merchandiser: '跟单', finance: '财务',
  procurement: '采购', production_manager: '生产主管',
  admin_assistant: '行政督办', logistics: '物流',
};

export async function getExecutionAnalytics(
  period: 'week' | 'month' | 'quarter' = 'month',
): Promise<{ data?: ExecutionSummary; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const now = new Date();
  let since: Date;
  let periodLabel: string;
  if (period === 'week') {
    since = new Date(now.getTime() - 7 * 86400000);
    periodLabel = '本周';
  } else if (period === 'month') {
    since = new Date(now.getFullYear(), now.getMonth(), 1);
    periodLabel = '本月';
  } else {
    since = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
    periodLabel = '本季';
  }
  const sinceStr = since.toISOString();

  // 获取所有有角色的用户
  const { data: profiles } = await (supabase.from('profiles') as any)
    .select('user_id, name, email, role, roles');

  const rankings: ExecutionScore[] = [];

  for (const p of (profiles || []) as any[]) {
    const roles: string[] = Array.isArray(p.roles) && p.roles.length > 0
      ? p.roles : [p.role].filter(Boolean);
    // 只统计执行角色（admin 不执行节点）
    const execRoles = roles.filter(r =>
      ['sales', 'merchandiser', 'finance', 'procurement', 'production_manager', 'logistics'].includes(r),
    );
    if (execRoles.length === 0) continue;

    const roleLabel = execRoles.map(r => ROLE_LABELS[r] || r).join('/');
    const name = p.name || p.email?.split('@')[0] || '未知';

    // 1. 该时间段内完成的节点
    const { data: doneMilestones } = await (supabase.from('milestones') as any)
      .select('id, due_at, actual_at, status')
      .eq('owner_user_id', p.user_id)
      .in('status', ['done', '已完成', 'completed'])
      .gte('actual_at', sinceStr);

    const completed = (doneMilestones || []) as any[];
    const completedCount = completed.length;

    // 2. 平均响应时间 = actual_at - due_at（如果提前完成算 0）
    let totalResponseDays = 0;
    let responseCount = 0;
    let overdueCompletedCount = 0;
    let fastest = Infinity;
    let slowest = 0;
    const totalOverdueDaysCompleted = 0;

    for (const m of completed) {
      if (!m.due_at || !m.actual_at) continue;
      const dueTs = new Date(m.due_at).getTime();
      const actualTs = new Date(m.actual_at).getTime();
      const diffDays = Math.max(0, (actualTs - dueTs) / 86400000);
      totalResponseDays += diffDays;
      responseCount++;
      if (diffDays < fastest) fastest = diffDays;
      if (diffDays > slowest) slowest = diffDays;
      if (actualTs > dueTs + 86400000) overdueCompletedCount++; // 超过 1 天算逾期
    }

    const avgResponseDays = responseCount > 0
      ? Number((totalResponseDays / responseCount).toFixed(1))
      : 0;

    // 3. 当前逾期数
    const { data: currentOverdue } = await (supabase.from('milestones') as any)
      .select('id, due_at')
      .eq('owner_user_id', p.user_id)
      .in('status', ['in_progress', '进行中'])
      .lt('due_at', now.toISOString());

    const currentOverdueCount = (currentOverdue || []).length;
    let totalOverdueDays = 0;
    for (const m of (currentOverdue || []) as any[]) {
      totalOverdueDays += Math.ceil((now.getTime() - new Date(m.due_at).getTime()) / 86400000);
    }

    // 4. 逾期率
    const overdueRate = completedCount > 0
      ? Number(((overdueCompletedCount / completedCount) * 100).toFixed(1))
      : 0;

    // 5. 升级次数（被 L2/L3 升级 = notification type 包含 escalation_xxx_L2 或 L3）
    const { data: escalations } = await (supabase.from('notifications') as any)
      .select('id')
      .eq('user_id', p.user_id)
      .like('type', 'escalation_%')
      .gte('created_at', sinceStr);
    const escalationCount = (escalations || []).length;

    // 6. 综合评分（0-100）
    // 准时率权重 40% + 响应速度 30% + 当前无逾期 20% + 无升级 10%
    const onTimeScore = Math.max(0, 100 - overdueRate); // 逾期率 0% = 100 分
    const speedScore = avgResponseDays <= 0.5 ? 100
      : avgResponseDays <= 1 ? 90
      : avgResponseDays <= 2 ? 75
      : avgResponseDays <= 3 ? 60
      : avgResponseDays <= 5 ? 40
      : 20;
    const noOverdueScore = currentOverdueCount === 0 ? 100
      : currentOverdueCount <= 2 ? 60
      : currentOverdueCount <= 5 ? 30
      : 0;
    const noEscalationScore = escalationCount === 0 ? 100
      : escalationCount <= 2 ? 60
      : 20;

    const executionScore = completedCount === 0 ? 0 : Math.round(
      onTimeScore * 0.4 + speedScore * 0.3 + noOverdueScore * 0.2 + noEscalationScore * 0.1,
    );

    const grade: ExecutionScore['grade'] =
      executionScore >= 90 ? 'S' :
      executionScore >= 75 ? 'A' :
      executionScore >= 60 ? 'B' :
      executionScore >= 40 ? 'C' : 'D';

    rankings.push({
      userId: p.user_id,
      name,
      email: p.email || '',
      roles: execRoles,
      roleLabel,
      completedCount,
      avgResponseDays,
      fastestResponseDays: fastest === Infinity ? 0 : Number(fastest.toFixed(1)),
      slowestResponseDays: Number(slowest.toFixed(1)),
      overdueCompletedCount,
      overdueRate,
      currentOverdueCount,
      totalOverdueDays,
      escalationCount,
      executionScore,
      grade,
      trend: 'stable', // TODO: 对比上期
    });
  }

  // 按执行力评分降序
  rankings.sort((a, b) => b.executionScore - a.executionScore || a.currentOverdueCount - b.currentOverdueCount);

  // 团队平均
  const activeRankings = rankings.filter(r => r.completedCount > 0);
  const teamAvg = {
    avgResponseDays: activeRankings.length > 0
      ? Number((activeRankings.reduce((s, r) => s + r.avgResponseDays, 0) / activeRankings.length).toFixed(1))
      : 0,
    overdueRate: activeRankings.length > 0
      ? Number((activeRankings.reduce((s, r) => s + r.overdueRate, 0) / activeRankings.length).toFixed(1))
      : 0,
    executionScore: activeRankings.length > 0
      ? Math.round(activeRankings.reduce((s, r) => s + r.executionScore, 0) / activeRankings.length)
      : 0,
  };

  return {
    data: {
      rankings,
      teamAvg,
      period: periodLabel,
      generatedAt: now.toISOString(),
    },
  };
}
