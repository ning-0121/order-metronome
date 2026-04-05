'use server';

import { createClient } from '@/lib/supabase/server';

/**
 * Agent 对话 — 用户提问，Agent 查数据后回答
 *
 * 安全：只查询当前用户可见的数据
 * 成本：每次 ~$0.01（Sonnet）
 */
export async function askAgent(question: string): Promise<{ answer: string; error?: string }> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { answer: '', error: '请先登录' };
    if (!question.trim()) return { answer: '', error: '请输入问题' };

    // 获取用户角色
    const { data: profile } = await (supabase.from('profiles') as any)
      .select('name, role, roles').eq('user_id', user.id).single();
    const userName = profile?.name || user.email?.split('@')[0];
    const userRoles: string[] = profile?.roles?.length > 0 ? profile.roles : [profile?.role].filter(Boolean);
    const isAdmin = userRoles.includes('admin');

    // 根据问题关键词，查询相关数据
    const context: string[] = [];

    // 1. 订单相关查询
    const orderNoMatch = question.match(/QM-\d{8}-\d{3}/i);
    if (orderNoMatch) {
      const { data: order } = await (supabase.from('orders') as any)
        .select('id, order_no, customer_name, factory_name, quantity, incoterm, order_type, lifecycle_status, factory_date, etd, created_at')
        .eq('order_no', orderNoMatch[0].toUpperCase()).single();
      if (order) {
        const { data: milestones } = await (supabase.from('milestones') as any)
          .select('name, status, due_at, owner_role').eq('order_id', order.id).order('due_at');
        const done = (milestones || []).filter((m: any) => m.status === 'done' || m.status === '已完成').length;
        const overdue = (milestones || []).filter((m: any) => m.due_at && new Date(m.due_at) < new Date() && m.status !== 'done' && m.status !== '已完成');
        context.push(`订单 ${order.order_no}：客户${order.customer_name}，工厂${order.factory_name || '未指定'}，${order.quantity}件，${order.incoterm}，状态${order.lifecycle_status}，出厂${order.factory_date || '未设'}。进度${done}/${(milestones || []).length}完成。`);
        if (overdue.length > 0) context.push(`超期节点：${overdue.map((m: any) => m.name).join('、')}`);
      }
    }

    // 2. 客户相关
    if (question.includes('客户') || question.includes('customer')) {
      const { data: orders } = await (supabase.from('orders') as any)
        .select('customer_name, quantity, lifecycle_status').limit(500);
      const customerMap: Record<string, { count: number; qty: number }> = {};
      for (const o of orders || []) {
        if (!o.customer_name) continue;
        if (!customerMap[o.customer_name]) customerMap[o.customer_name] = { count: 0, qty: 0 };
        customerMap[o.customer_name].count++;
        customerMap[o.customer_name].qty += o.quantity || 0;
      }
      const top5 = Object.entries(customerMap).sort((a, b) => b[1].count - a[1].count).slice(0, 5);
      context.push(`客户概览（Top5）：${top5.map(([name, s]) => `${name}(${s.count}单/${s.qty}件)`).join('、')}`);
    }

    // 3. 超期/风险
    if (question.includes('超期') || question.includes('风险') || question.includes('逾期') || question.includes('问题')) {
      const { data: overdue } = await (supabase.from('milestones') as any)
        .select('name, due_at, owner_role, orders!inner(order_no, customer_name)')
        .in('status', ['in_progress', '进行中'])
        .lt('due_at', new Date().toISOString())
        .order('due_at').limit(10);
      if (overdue && overdue.length > 0) {
        context.push(`当前超期节点（${overdue.length}个）：${overdue.map((m: any) => `${m.orders?.order_no}-${m.name}(${m.owner_role})`).join('、')}`);
      } else {
        context.push('当前无超期节点。');
      }
    }

    // 4. 今日待办
    if (question.includes('今天') || question.includes('今日') || question.includes('待办')) {
      const today = new Date().toISOString().slice(0, 10);
      const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const { data: todayDue } = await (supabase.from('milestones') as any)
        .select('name, owner_role, orders!inner(order_no)')
        .gte('due_at', today + 'T00:00:00')
        .lt('due_at', tomorrow + 'T00:00:00')
        .not('status', 'in', '("done","已完成")').limit(10);
      context.push(`今日到期节点：${todayDue && todayDue.length > 0 ? todayDue.map((m: any) => `${m.orders?.order_no}-${m.name}`).join('、') : '无'}`);
    }

    // 5. 工厂相关
    if (question.includes('工厂') || question.includes('产能')) {
      const { data: factories } = await (supabase.from('factories') as any)
        .select('factory_name, worker_count, monthly_capacity, product_categories')
        .is('deleted_at', null).limit(20);
      if (factories && factories.length > 0) {
        context.push(`工厂列表：${factories.map((f: any) => `${f.factory_name}(${f.worker_count || '?'}人/月产${f.monthly_capacity || '?'}件)`).join('、')}`);
      }
    }

    // 6. 通用统计
    if (context.length === 0) {
      const { data: orders } = await (supabase.from('orders') as any)
        .select('id, lifecycle_status').limit(500);
      const total = (orders || []).length;
      const active = (orders || []).filter((o: any) => !['已完成', '已取消', '已复盘', 'completed', 'cancelled'].includes(o.lifecycle_status || '')).length;
      context.push(`系统共 ${total} 个订单，${active} 个进行中。`);
    }

    // 调用 Claude
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic();

    const { buildIndustryPrompt } = await import('@/lib/agent/industryKnowledge');
    const systemPrompt = `你是「订单节拍器」的 AI 助手，具备外贸服装行业专业知识。你帮助员工查询订单状态、分析风险、给出专业建议。

${buildIndustryPrompt()}

当前用户：${userName}，角色：${userRoles.join('/')}
回答要求：简洁、专业、用中文。结合行业知识给出实用建议。不要编造数据。`;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: `用户问题：${question}\n\n系统数据：\n${context.join('\n')}`,
      }],
    });

    const answer = response.content[0].type === 'text' ? response.content[0].text : '无法回答';
    return { answer };
  } catch (err: any) {
    console.error('[askAgent]', err?.message);
    return { answer: '', error: '回答失败，请稍后再试' };
  }
}
