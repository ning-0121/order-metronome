'use server';

import { createClient } from '@/lib/supabase/server';

/**
 * Agent 对话 — 业务员的 AI 专业助手
 *
 * 能力：
 * 1. 服装外贸专业知识（面料/工艺/贸易术语/报关/物流）
 * 2. 公司知识库（ai_knowledge_base 的 RAG 检索）
 * 3. 订单实时查询（状态/进度/交期/成本）
 * 4. 客户回复建议（根据订单上下文生成专业回复）
 *
 * 安全：只查询当前用户可见的数据
 */
export async function askAgent(question: string): Promise<{ answer: string; error?: string }> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { answer: '', error: '请先登录' };
    if (!question.trim()) return { answer: '', error: '请输入问题' };

    const { data: profile } = await (supabase.from('profiles') as any)
      .select('name, role, roles').eq('user_id', user.id).single();
    const userName = profile?.name || user.email?.split('@')[0];
    const userRoles: string[] = profile?.roles?.length > 0 ? profile.roles : [profile?.role].filter(Boolean);

    const context: string[] = [];

    // ═══ 1. 订单查询（订单号匹配） ═══
    const orderNoMatch = question.match(/QM-\d{8}-\d{3}/i);
    if (orderNoMatch) {
      const { data: order } = await (supabase.from('orders') as any)
        .select('id, order_no, customer_name, factory_name, quantity, incoterm, order_type, lifecycle_status, factory_date, etd, warehouse_due_date, style_no, po_number')
        .eq('order_no', orderNoMatch[0].toUpperCase()).single();
      if (order) {
        const [msRes, finRes, confRes] = await Promise.all([
          (supabase.from('milestones') as any)
            .select('name, status, due_at, owner_role').eq('order_id', order.id).order('due_at'),
          (supabase.from('order_financials') as any)
            .select('margin_pct, deposit_status, balance_status, payment_hold').eq('order_id', order.id).maybeSingle(),
          (supabase.from('order_confirmations') as any)
            .select('module, status').eq('order_id', order.id),
        ]);

        const milestones = msRes.data || [];
        const done = milestones.filter((m: any) => m.status === 'done' || m.status === '已完成').length;
        const overdue = milestones.filter((m: any) => m.due_at && new Date(m.due_at) < new Date() && m.status !== 'done' && m.status !== '已完成');
        const active = milestones.filter((m: any) => m.status === 'in_progress' || m.status === '进行中');

        context.push(`📦 订单 ${order.order_no}：`);
        context.push(`  客户：${order.customer_name} | 工厂：${order.factory_name || '未指定'} | ${order.quantity}件 | ${order.incoterm}`);
        context.push(`  款号：${order.style_no || '—'} | PO：${order.po_number || '—'} | 类型：${order.order_type}`);
        context.push(`  出厂日：${order.factory_date || '未设'} | 状态：${order.lifecycle_status}`);
        context.push(`  进度：${done}/${milestones.length} 完成`);
        if (active.length > 0) context.push(`  进行中：${active.map((m: any) => m.name).join('、')}`);
        if (overdue.length > 0) context.push(`  ⚠ 超期：${overdue.map((m: any) => m.name).join('、')}`);

        if (finRes.data) {
          const f = finRes.data;
          context.push(`  利润：毛利率 ${f.margin_pct ?? '未录入'}% | 定金：${f.deposit_status} | 尾款：${f.balance_status}${f.payment_hold ? ' | ⚠付款暂停' : ''}`);
        }
        if (confRes.data?.length > 0) {
          const pending = confRes.data.filter((c: any) => c.status !== 'confirmed');
          if (pending.length > 0) context.push(`  确认链待确认：${pending.map((c: any) => c.module).join('、')}`);
        }
      }
    }

    // ═══ 2. 公司知识库 RAG ═══
    try {
      const keywords = question.replace(/[？?！!。，,\s]+/g, ' ').split(' ').filter(w => w.length >= 2).slice(0, 5);
      if (keywords.length > 0) {
        const { data: knowledge } = await (supabase.from('ai_knowledge_base') as any)
          .select('title, content, category, tags')
          .or(keywords.map(k => `title.ilike.%${k}%,content.ilike.%${k}%,tags.cs.{${k}}`).join(','))
          .limit(5);
        if (knowledge && knowledge.length > 0) {
          context.push('\n📚 公司知识库匹配：');
          for (const k of knowledge as any[]) {
            context.push(`  [${k.category}] ${k.title}：${(k.content || '').slice(0, 200)}`);
          }
        }
      }
    } catch {}

    // ═══ 3. 客户相关 ═══
    if (question.includes('客户') || question.includes('customer')) {
      const { data: orders } = await (supabase.from('orders') as any)
        .select('customer_name, quantity, lifecycle_status').limit(500);
      const customerMap: Record<string, { count: number; qty: number }> = {};
      for (const o of (orders || []) as any[]) {
        if (!o.customer_name) continue;
        if (!customerMap[o.customer_name]) customerMap[o.customer_name] = { count: 0, qty: 0 };
        customerMap[o.customer_name].count++;
        customerMap[o.customer_name].qty += o.quantity || 0;
      }
      const top5 = Object.entries(customerMap).sort((a, b) => b[1].count - a[1].count).slice(0, 5);
      context.push(`\n👥 客户概览（Top5）：${top5.map(([name, s]) => `${name}(${s.count}单/${s.qty}件)`).join('、')}`);
    }

    // ═══ 4. 超期/风险 ═══
    if (question.includes('超期') || question.includes('风险') || question.includes('逾期') || question.includes('问题')) {
      const { data: overdue } = await (supabase.from('milestones') as any)
        .select('name, due_at, owner_role, orders!inner(order_no, customer_name)')
        .in('status', ['in_progress', '进行中'])
        .lt('due_at', new Date().toISOString())
        .order('due_at').limit(10);
      if (overdue && overdue.length > 0) {
        context.push(`\n⚠ 当前超期节点（${overdue.length}个）：${overdue.map((m: any) => `${m.orders?.order_no}-${m.name}`).join('、')}`);
      } else {
        context.push('\n✅ 当前无超期节点。');
      }
    }

    // ═══ 5. 今日待办 ═══
    if (question.includes('今天') || question.includes('今日') || question.includes('待办')) {
      const today = new Date().toISOString().slice(0, 10);
      const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const { data: todayDue } = await (supabase.from('milestones') as any)
        .select('name, owner_role, orders!inner(order_no)')
        .gte('due_at', today + 'T00:00:00')
        .lt('due_at', tomorrow + 'T00:00:00')
        .not('status', 'in', '("done","已完成")').limit(10);
      context.push(`\n📋 今日到期：${todayDue && todayDue.length > 0 ? todayDue.map((m: any) => `${m.orders?.order_no}-${m.name}`).join('、') : '无'}`);
    }

    // ═══ 6. 工厂 ═══
    if (question.includes('工厂') || question.includes('产能') || question.includes('factory')) {
      const { data: factories } = await (supabase.from('factories') as any)
        .select('factory_name, worker_count, monthly_capacity, product_categories')
        .is('deleted_at', null).limit(20);
      if (factories && factories.length > 0) {
        context.push(`\n🏭 工厂：${factories.map((f: any) => `${f.factory_name}(${f.worker_count || '?'}人/月产${f.monthly_capacity || '?'}件)`).join('、')}`);
      }
    }

    // ═══ 7. 兜底统计 ═══
    if (context.length === 0) {
      const { data: orders } = await (supabase.from('orders') as any)
        .select('id, lifecycle_status').limit(500);
      const total = (orders || []).length;
      const active = (orders || []).filter((o: any) => !['已完成', '已取消', '已复盘', 'completed', 'cancelled'].includes(o.lifecycle_status || '')).length;
      context.push(`系统共 ${total} 个订单，${active} 个进行中。`);
    }

    // ═══ 调用 Claude ═══
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic();

    const { buildIndustryPrompt } = await import('@/lib/agent/industryKnowledge');

    const systemPrompt = `你是「绮陌服饰智能系统」的 AI 业务助手，名字叫"小绮"。

**你的身份**：10年外贸服装行业专家 + 公司内部知识专家。

**你的能力**：
1. 服装外贸专业知识：面料（克重/成分/缩水率/色牢度）、工艺（印花/绣花/洗水）、贸易术语（FOB/DDP/CIF/L/C）、报关（HS编码/原产地证/商检）、物流（海运/空运/快递/集装箱）
2. 帮业务员组织专业的客户回复邮件
3. 查询订单状态和进度
4. 分析风险和给出建议

**回复规则**：
- 简洁专业，用中文
- 如果是帮写邮件回复，给出中英文两个版本
- 如果涉及具体订单数据，只用系统提供的数据，不编造
- 如果问题涉及你不确定的专业知识，说明"建议进一步确认"
- 回复要有行业深度，让客户感受到专业性

${buildIndustryPrompt()}

当前用户：${userName}，角色：${userRoles.join('/')}`;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1200,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: context.length > 0
          ? `用户问题：${question}\n\n系统数据：\n${context.join('\n')}`
          : `用户问题：${question}`,
      }],
    });

    const answer = response.content[0].type === 'text' ? response.content[0].text : '无法回答';
    return { answer };
  } catch (err: any) {
    console.error('[askAgent]', err?.message);
    if (err?.message?.includes('credit') || err?.message?.includes('billing')) {
      return { answer: '', error: 'AI 服务余额不足，请联系管理员充值' };
    }
    return { answer: '', error: '回答失败，请稍后再试' };
  }
}
