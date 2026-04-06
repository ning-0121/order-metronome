/**
 * Agent 学习 Cron — 每周日晚运行
 *
 * 分析过去7天的建议执行/忽略数据，自动调整策略：
 * 1. 执行率高的建议类型 → 降低触发阈值（更早触发）
 * 2. 执行率低的建议类型 → 提高触发阈值（减少噪音）
 * 3. 生成周报存入 ai_knowledge_base
 * 4. 更新客户画像和工厂画像
 */

import { createClient } from '@supabase/supabase-js';
import { analyzeAndTune } from '@/lib/agent/selfTuning';
import { NextResponse } from 'next/server';

export const maxDuration = 30;

export async function POST(req: Request) {
  try {
    const authHeader = req.headers.get('authorization');
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) return NextResponse.json({ error: 'Missing config' }, { status: 500 });

    const supabase = createClient(url, serviceKey);

    // 1. 执行率分析 + 调参
    const tuningResults = await analyzeAndTune(supabase);

    // 2. 生成周报摘要（用 Claude 总结）
    let weeklyReport = '';
    try {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const client = new Anthropic();

      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const { count: totalSuggestions } = await supabase.from('agent_actions').select('id', { count: 'exact', head: true }).gte('created_at', weekAgo);
      const { count: executed } = await supabase.from('agent_actions').select('id', { count: 'exact', head: true }).eq('status', 'executed').gte('created_at', weekAgo);
      const { count: dismissed } = await supabase.from('agent_actions').select('id', { count: 'exact', head: true }).eq('status', 'dismissed').gte('created_at', weekAgo);
      const { count: emailsProcessed } = await supabase.from('mail_inbox').select('id', { count: 'exact', head: true }).gte('received_at', weekAgo);

      // 本周最常超期的节点
      const { data: overdueNodes } = await supabase
        .from('milestones')
        .select('name, owner_role')
        .in('status', ['in_progress', '进行中'])
        .lt('due_at', new Date().toISOString())
        .limit(20);

      const nodeCount: Record<string, number> = {};
      for (const n of overdueNodes || []) { nodeCount[n.name] = (nodeCount[n.name] || 0) + 1; }
      const topOverdue = Object.entries(nodeCount).sort((a, b) => b[1] - a[1]).slice(0, 5);

      const prompt = `你是外贸订单管理AI Agent的运营分析师。根据以下本周数据，生成一份简短的周报（5-8句话）：

本周Agent数据：
- 生成建议 ${totalSuggestions || 0} 条，执行 ${executed || 0} 条，忽略 ${dismissed || 0} 条
- 执行率 ${(executed || 0) + (dismissed || 0) > 0 ? Math.round(((executed || 0) / ((executed || 0) + (dismissed || 0))) * 100) : 0}%
- 处理邮件 ${emailsProcessed || 0} 封
- 当前超期节点 Top5：${topOverdue.map(([name, count]) => `${name}(${count}个)`).join('、') || '无'}

调参结果：
${tuningResults.map(r => `${r.actionType}: 执行率${r.executionRate}% → ${r.adjustment === 'lower_threshold' ? '提前触发' : r.adjustment === 'raise_threshold' ? '减少频率' : '保持不变'}`).join('\n')}

请给出：
1. 本周Agent表现总结
2. 发现的模式和趋势
3. 下周优化建议（具体可执行的）

直接输出文字，不要JSON。`;

      const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514', max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      });
      weeklyReport = response.content[0].type === 'text' ? response.content[0].text : '';
    } catch (err: any) {
      weeklyReport = `本周执行率分析完成，${tuningResults.length} 个动作类型已评估。`;
    }

    // 3. 存入知识库
    await supabase.from('ai_knowledge_base').insert({
      source_type: 'agent_weekly_report',
      category: 'self_learning',
      title: `Agent 周报 — ${new Date().toISOString().slice(0, 10)}`,
      content: weeklyReport,
      structured_data: { tuningResults, generatedAt: new Date().toISOString() },
      confidence: 0.9,
    });

    // 4. 通知管理员
    const { data: admins } = await supabase.from('profiles').select('user_id').or("role.eq.admin,roles.cs.{admin}");
    for (const admin of admins || []) {
      await supabase.from('notifications').insert({
        user_id: admin.user_id,
        type: 'agent_weekly_report',
        title: '🤖 Agent 周报已生成',
        message: weeklyReport.slice(0, 200) + '...',
        status: 'unread',
      });
    }

    // 5. 邮件画像学习：分析客户邮件沟通模式
    let customersLearned = 0;
    try {
      const { learnAllCustomerProfiles } = await import('@/lib/agent/emailLearning');
      customersLearned = await learnAllCustomerProfiles(supabase);
    } catch {}

    return NextResponse.json({ success: true, tuningResults, report: weeklyReport.slice(0, 200), customersLearned });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}

export async function GET(req: Request) { return POST(req); }
