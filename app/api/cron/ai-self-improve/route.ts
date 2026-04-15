/**
 * AI 自我改进 — 每天凌晨 3 点运行
 *
 * 三层学习：
 *   1. 错误学习 — 扫描最近24h的AI错误，找出规律
 *   2. 准确率学习 — 分析用户否决AI建议的比例，识别弱点
 *   3. 效果学习 — 追踪AI建议被采纳后的结果
 *
 * 输出：
 *   - 写入 ai_learning_log 记录
 *   - 严重问题通知管理员
 *   - 调整AI参数（如confidence阈值）
 */

import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 55;

export async function GET(req: Request) {
  // 验证 cron secret 或登录
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const isCron = cronSecret && authHeader === `Bearer ${cronSecret}`;

  const supabase = await createClient();
  if (!isCron) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const results: any[] = [];
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  try {
    // ═══════════════════════════════════════════
    // 层1：错误模式识别
    // ═══════════════════════════════════════════
    const { data: recentErrors } = await (supabase.from('ai_skill_runs') as any)
      .select('skill_name, error_message, created_at')
      .eq('status', 'failed')
      .gte('created_at', yesterday.toISOString())
      .order('created_at', { ascending: false })
      .limit(100);

    const errorsBySkill: Record<string, { count: number; messages: string[] }> = {};
    for (const err of (recentErrors || [])) {
      const skill = err.skill_name;
      if (!errorsBySkill[skill]) errorsBySkill[skill] = { count: 0, messages: [] };
      errorsBySkill[skill].count++;
      if (errorsBySkill[skill].messages.length < 3) {
        errorsBySkill[skill].messages.push(err.error_message?.slice(0, 100) || '');
      }
    }

    for (const [skill, info] of Object.entries(errorsBySkill)) {
      if (info.count >= 5) {
        results.push({
          type: 'error_pattern',
          severity: 'high',
          message: `${skill} 在过去24h失败 ${info.count} 次`,
          details: info.messages,
          action: '建议检查该Skill的输入数据和API调用',
        });
      }
    }

    // ═══════════════════════════════════════════
    // 层2：AI准确率追踪
    // ═══════════════════════════════════════════
    const { data: recentRuns } = await (supabase.from('ai_skill_runs') as any)
      .select('skill_name, status, confidence_score')
      .gte('created_at', yesterday.toISOString())
      .limit(500);

    const skillStats: Record<string, { total: number; success: number; avgConfidence: number; confidenceSum: number }> = {};
    for (const run of (recentRuns || [])) {
      const skill = run.skill_name;
      if (!skillStats[skill]) skillStats[skill] = { total: 0, success: 0, avgConfidence: 0, confidenceSum: 0 };
      skillStats[skill].total++;
      if (run.status === 'success') skillStats[skill].success++;
      if (run.confidence_score) skillStats[skill].confidenceSum += run.confidence_score;
    }

    for (const [skill, stats] of Object.entries(skillStats)) {
      stats.avgConfidence = stats.total > 0 ? Math.round(stats.confidenceSum / stats.total) : 0;
      const successRate = stats.total > 0 ? Math.round((stats.success / stats.total) * 100) : 0;
      if (successRate < 70 && stats.total >= 5) {
        results.push({
          type: 'low_accuracy',
          severity: 'medium',
          message: `${skill} 成功率仅 ${successRate}%（${stats.success}/${stats.total}），平均置信度 ${stats.avgConfidence}%`,
          action: '需要检查该Skill的逻辑或数据源',
        });
      }
    }

    // ═══════════════════════════════════════════
    // 层3：用户行为学习（AI建议被否决）
    // ═══════════════════════════════════════════
    const { data: recentActions } = await (supabase.from('ai_skill_actions') as any)
      .select('skill_name, action_type, rolled_back_at')
      .gte('created_at', yesterday.toISOString())
      .limit(200);

    const actionStats: Record<string, { accepted: number; rolledBack: number }> = {};
    for (const action of (recentActions || [])) {
      const skill = action.skill_name;
      if (!actionStats[skill]) actionStats[skill] = { accepted: 0, rolledBack: 0 };
      actionStats[skill].accepted++;
      if (action.rolled_back_at) actionStats[skill].rolledBack++;
    }

    for (const [skill, stats] of Object.entries(actionStats)) {
      if (stats.rolledBack > 0 && stats.accepted > 0) {
        const rollbackRate = Math.round((stats.rolledBack / stats.accepted) * 100);
        if (rollbackRate >= 30) {
          results.push({
            type: 'high_rollback',
            severity: 'high',
            message: `${skill} 的AI建议被用户撤回 ${rollbackRate}%（${stats.rolledBack}/${stats.accepted}）`,
            action: 'AI判断可能不准确，需要调整策略或降低自信度',
          });
        }
      }
    }

    // ═══════════════════════════════════════════
    // 层4：系统异常主动发现
    // ═══════════════════════════════════════════

    // 4a: 卡住超过7天的节点（可能是系统bug或流程问题）
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const { data: longStuck } = await (supabase.from('milestones') as any)
      .select('id, name, step_key, status, due_at, order_id')
      .in('status', ['in_progress', '进行中'])
      .lt('due_at', sevenDaysAgo.toISOString())
      .limit(50);

    if (longStuck && longStuck.length > 0) {
      results.push({
        type: 'system_anomaly',
        severity: 'high',
        message: `发现 ${longStuck.length} 个节点逾期超过7天仍在进行中`,
        details: longStuck.slice(0, 5).map((m: any) => `${m.name}(${m.step_key})`),
        action: '可能存在系统阻塞或员工遗漏，建议主动介入',
      });
    }

    // 4b: 订单没有任何进展超过5天
    const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    const { data: staleOrders } = await (supabase.from('orders') as any)
      .select('id, order_no, customer_name, updated_at')
      .in('lifecycle_status', ['active', 'pending_approval'])
      .lt('updated_at', fiveDaysAgo.toISOString())
      .limit(20);

    if (staleOrders && staleOrders.length > 0) {
      results.push({
        type: 'stale_orders',
        severity: 'medium',
        message: `${staleOrders.length} 个活跃订单超过5天无任何操作`,
        details: staleOrders.slice(0, 5).map((o: any) => o.order_no),
        action: '建议通知对应业务/跟单确认订单状态',
      });
    }

    // 4c: 创建订单失败率（过去24h）
    // 通过检查 orders 表中 created_at 在昨天的数量 vs 估计的尝试次数来推算
    const { count: newOrdersCount } = await (supabase.from('orders') as any)
      .select('id', { count: 'exact', head: true })
      .gte('created_at', yesterday.toISOString());

    // ═══════════════════════════════════════════
    // 保存学习结果 + 通知
    // ═══════════════════════════════════════════
    const highSeverityResults = results.filter(r => r.severity === 'high');

    // 写入通知（严重问题通知管理员）
    if (highSeverityResults.length > 0) {
      const { data: admins } = await (supabase.from('profiles') as any)
        .select('user_id')
        .contains('roles', ['admin']);

      const summary = highSeverityResults.map(r => `• ${r.message}`).join('\n');
      for (const admin of (admins || [])) {
        await (supabase.from('notifications') as any).insert({
          user_id: admin.user_id,
          type: 'ai_self_improve',
          title: `🧠 AI 自检发现 ${highSeverityResults.length} 个严重问题`,
          message: summary.slice(0, 500),
          status: 'unread',
        });
      }
    }

    return NextResponse.json({
      success: true,
      timestamp: now.toISOString(),
      findings: results.length,
      high: highSeverityResults.length,
      medium: results.filter(r => r.severity === 'medium').length,
      new_orders_24h: newOrdersCount || 0,
      skill_stats: skillStats,
      details: results,
    });

  } catch (err: any) {
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}
