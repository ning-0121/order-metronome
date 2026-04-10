/**
 * Skill 7 — 今日行动清单
 *
 * 核心价值：整合其他所有 Skill + 节点逾期 + 即将到期 → 给当前用户一个
 * "今天必须做的 3 件事 + 本周要关注的 5 件事"清单。
 *
 * 不调 AI — 纯规则聚合，速度快（<500ms）
 *
 * 与 daily-tasks cron 的区别：
 *   - daily-tasks 是早上推送（push）
 *   - todayActions 是打开订单时拉取（pull），实时反映当前状态
 */

import type {
  SkillModule,
  SkillInput,
  SkillResult,
  SkillFinding,
  SkillContext,
} from './types';

export const todayActionsSkill: SkillModule = {
  name: 'milestone_generation' as any, // 复用 type 定义中的空位
  displayName: '今日行动',
  cacheTtlMs: 5 * 60 * 1000, // 5min

  hashInput: (input: SkillInput) =>
    JSON.stringify({ userId: input.userId, version: 'v1' }),

  async run(input: SkillInput, ctx: SkillContext): Promise<SkillResult> {
    const userId = ctx.userId || input.userId;
    if (!userId) throw new Error('需要 userId');

    const now = new Date();
    const threeDaysLater = new Date(now.getTime() + 3 * 86400000);

    // 1. 我负责的所有进行中节点
    const { data: myMilestones } = await (ctx.supabase.from('milestones') as any)
      .select('id, name, step_key, due_at, status, order_id, orders!inner(order_no, customer_name)')
      .eq('owner_user_id', userId)
      .in('status', ['in_progress', '进行中'])
      .order('due_at', { ascending: true })
      .limit(30);

    const milestones = (myMilestones || []) as any[];

    // 分类
    const overdue: typeof milestones = [];
    const todayDue: typeof milestones = [];
    const soonDue: typeof milestones = []; // 3 天内
    const normal: typeof milestones = [];

    for (const m of milestones) {
      if (!m.due_at) { normal.push(m); continue; }
      const dueDate = new Date(m.due_at);
      const diffDays = Math.ceil((dueDate.getTime() - now.getTime()) / 86400000);
      if (diffDays < 0) overdue.push(m);
      else if (diffDays === 0) todayDue.push(m);
      else if (diffDays <= 3) soonDue.push(m);
      else normal.push(m);
    }

    // 2. 待审批项（延期申请等）
    let pendingApprovals = 0;
    try {
      const { count } = await (ctx.supabase.from('delay_requests') as any)
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending');
      pendingApprovals = count || 0;
    } catch {}

    // 3. 未读通知数
    let unreadCount = 0;
    try {
      const { count } = await (ctx.supabase.from('notifications') as any)
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('status', 'unread');
      unreadCount = count || 0;
    } catch {}

    // 组装 findings
    const findings: SkillFinding[] = [];

    // 🔴 逾期（最高优先级）
    for (const m of overdue.slice(0, 5)) {
      const days = Math.ceil((now.getTime() - new Date(m.due_at).getTime()) / 86400000);
      findings.push({
        category: '🔴 立即处理',
        severity: 'high',
        label: `${m.orders?.order_no} · ${m.name}`,
        detail: `逾期 ${days} 天 — ${m.orders?.customer_name || ''}`,
        whoShouldFix: 'sales',
      });
    }

    // 🟠 今天到期
    for (const m of todayDue.slice(0, 3)) {
      findings.push({
        category: '🟠 今天截止',
        severity: 'medium',
        label: `${m.orders?.order_no} · ${m.name}`,
        detail: m.orders?.customer_name || '',
      });
    }

    // 🟡 3 天内
    for (const m of soonDue.slice(0, 3)) {
      const days = Math.ceil((new Date(m.due_at).getTime() - now.getTime()) / 86400000);
      findings.push({
        category: '🟡 本周关注',
        severity: 'low',
        label: `${m.orders?.order_no} · ${m.name}`,
        detail: `还剩 ${days} 天 — ${m.orders?.customer_name || ''}`,
      });
    }

    // 待审批
    if (pendingApprovals > 0) {
      findings.push({
        category: '📋 待审批',
        severity: 'medium',
        label: `${pendingApprovals} 个延期申请待审核`,
      });
    }

    // 未读通知
    if (unreadCount > 5) {
      findings.push({
        category: '🔔 通知',
        severity: 'low',
        label: `${unreadCount} 条未读通知`,
      });
    }

    // 总结
    const totalUrgent = overdue.length + todayDue.length;
    let severity: 'high' | 'medium' | 'low' =
      overdue.length > 0 ? 'high' : todayDue.length > 0 ? 'medium' : 'low';

    const summary =
      overdue.length > 0
        ? `🔴 ${overdue.length} 项逾期需立即处理，${todayDue.length} 项今天截止`
        : todayDue.length > 0
        ? `🟠 ${todayDue.length} 项今天截止`
        : soonDue.length > 0
        ? `🟡 ${soonDue.length} 项本周即将到期`
        : `✅ 当前无紧急任务`;

    return {
      severity,
      summary,
      findings,
      suggestions: overdue.length > 0
        ? [{ action: `先处理 ${overdue[0].orders?.order_no} 的 ${overdue[0].name}（逾期最久）`, reason: '逾期最久 = 影响最大' }]
        : [],
      confidence: 100,
      source: 'rules',
      meta: {
        overdueCount: overdue.length,
        todayCount: todayDue.length,
        soonCount: soonDue.length,
        totalActive: milestones.length,
        pendingApprovals,
        unreadCount,
      },
    };
  },
};
