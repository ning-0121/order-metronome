'use server';

import { createClient } from '@/lib/supabase/server';

/**
 * Agent 对话 — 业务员的 AI 专业助手（小绮）V2.0
 *
 * V2.0 升级：
 * 1. 多轮对话历史支持（最近 8 条）
 * 2. 客户画像记忆接入（customer_memory 表）
 * 3. 工厂档案接入（工人数/月产能/品类/历史评级）
 * 4. 角色专属上下文（业务/采购/财务/品控看到不同重点）
 * 5. 今日超期摘要（每次都携带，增强上下文感知）
 * 6. max_tokens 1200 → 1600，更丰富的回复
 *
 * 安全：只查询当前用户可见的数据
 */

export interface ChatMessage {
  role: 'user' | 'agent';
  content: string;
}

export async function askAgent(
  question: string,
  history?: ChatMessage[],
): Promise<{ answer: string; error?: string }> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { answer: '', error: '请先登录' };
    if (!question.trim()) return { answer: '', error: '请输入问题' };

    const { data: profile } = await (supabase.from('profiles') as any)
      .select('name, role, roles').eq('user_id', user.id).single();
    const userName = profile?.name || user.email?.split('@')[0];
    const userRoles: string[] = profile?.roles?.length > 0 ? profile.roles : [profile?.role].filter(Boolean);
    const primaryRole = userRoles[0] || 'sales';

    const context: string[] = [];

    // ═══ 1. 订单查询（订单号匹配，大小写兼容） ═══
    const orderNoMatch = question.match(/QM-\d{8}-\d{3}/i);
    if (orderNoMatch) {
      const { data: order } = await (supabase.from('orders') as any)
        .select('id, order_no, customer_name, factory_name, factory_id, quantity, incoterm, order_type, lifecycle_status, factory_date, etd, warehouse_due_date, style_no, po_number, special_tags, is_new_customer, is_new_factory')
        .eq('order_no', orderNoMatch[0].toUpperCase()).single();
      if (order) {
        const [msRes, finRes, confRes, memRes] = await Promise.all([
          (supabase.from('milestones') as any)
            .select('name, status, due_at, owner_role, step_key').eq('order_id', order.id).order('due_at'),
          (supabase.from('order_financials') as any)
            .select('margin_pct, deposit_status, deposit_amount, balance_status, balance_amount, payment_hold, allow_production, allow_shipment').eq('order_id', order.id).maybeSingle(),
          (supabase.from('order_confirmations') as any)
            .select('module, status').eq('order_id', order.id),
          // 该客户的记忆卡片（最多 3 条高/中风险）
          (supabase.from('customer_memory') as any)
            .select('category, risk_level, content')
            .eq('customer_id', order.customer_name)
            .in('risk_level', ['high', 'medium'])
            .order('created_at', { ascending: false })
            .limit(3),
        ]);

        const milestones = msRes.data || [];
        const done = milestones.filter((m: any) => m.status === 'done' || m.status === '已完成').length;
        const overdue = milestones.filter((m: any) => m.due_at && new Date(m.due_at) < new Date() && m.status !== 'done' && m.status !== '已完成');
        const active = milestones.filter((m: any) => m.status === 'in_progress' || m.status === '进行中');
        const blocked = milestones.filter((m: any) => m.status === 'blocked' || m.status === '卡单');

        context.push(`📦 订单 ${order.order_no}：`);
        context.push(`  客户：${order.customer_name}${order.is_new_customer ? '（新客户首单）' : ''} | 工厂：${order.factory_name || '未指定'}${order.is_new_factory ? '（新工厂）' : ''} | ${order.quantity}件 | ${order.incoterm}`);
        context.push(`  款号：${order.style_no || '—'} | PO：${order.po_number || '—'} | 类型：${order.order_type}`);
        context.push(`  出厂日：${order.factory_date || '未设'} | 状态：${order.lifecycle_status}`);
        context.push(`  进度：${done}/${milestones.length} 完成 | 进行中：${active.length} | 超期：${overdue.length} | 阻塞：${blocked.length}`);
        if (active.length > 0) context.push(`  进行中节点：${active.map((m: any) => m.name).join('、')}`);
        if (overdue.length > 0) context.push(`  ⚠ 超期节点：${overdue.map((m: any) => `${m.name}（${m.owner_role || '未分配'}）`).join('、')}`);
        if (blocked.length > 0) context.push(`  🚫 阻塞节点：${blocked.map((m: any) => m.name).join('、')}`);
        if (Array.isArray(order.special_tags) && order.special_tags.length > 0) {
          context.push(`  特殊标签：${order.special_tags.join('、')}`);
        }

        if (finRes.data) {
          const f = finRes.data;
          const finParts = [];
          if (f.margin_pct !== null) finParts.push(`毛利率 ${f.margin_pct}%${f.margin_pct < 8 ? '（⚠低于8%底线）' : ''}`);
          if (f.deposit_amount) finParts.push(`定金 ${f.deposit_status === 'received' ? '✅已收' : '⏳未收'}（¥${f.deposit_amount}）`);
          if (f.balance_amount) finParts.push(`尾款 ${f.balance_status === 'received' ? '✅已收' : f.balance_status === 'overdue' ? '⚠逾期' : '⏳未收'}（¥${f.balance_amount}）`);
          if (f.payment_hold) finParts.push('⚠付款暂停');
          if (!f.allow_production) finParts.push('⚠生产未放行');
          if (!f.allow_shipment) finParts.push('⚠出货未放行');
          if (finParts.length > 0) context.push(`  💰 经营：${finParts.join(' | ')}`);
        }

        if (confRes.data?.length > 0) {
          const pending = confRes.data.filter((c: any) => c.status !== 'confirmed');
          if (pending.length > 0) {
            const labels: Record<string, string> = { fabric_color: '面料颜色', size_breakdown: '尺码配比', logo_print: 'Logo/印花', packaging_label: '包装唛头' };
            context.push(`  ✅ 确认链：${pending.length} 项待确认（${pending.map((c: any) => labels[c.module] || c.module).join('、')}）`);
          } else {
            context.push('  ✅ 确认链：全部已确认');
          }
        }

        if (memRes.data && memRes.data.length > 0) {
          context.push(`\n⚡ ${order.customer_name} 客户记忆（风险提示）：`);
          for (const m of memRes.data) {
            context.push(`  [${m.risk_level === 'high' ? '🔴高' : '🟡中'}/${m.category}] ${m.content}`);
          }
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
          .limit(4);
        if (knowledge && knowledge.length > 0) {
          context.push('\n📚 公司知识库匹配：');
          for (const k of knowledge as any[]) {
            context.push(`  [${k.category}] ${k.title}：${(k.content || '').slice(0, 200)}`);
          }
        }
      }
    } catch {}

    // ═══ 3. 客户相关（含记忆卡片） ═══
    if (question.includes('客户') || question.includes('customer')) {
      // 提取客户名（尝试匹配问题中的英文大写单词或"XXX客户"）
      const customerNameMatch = question.match(/([A-Z][A-Za-z\s&]+)(?:客户|的订单|的记录)?/) || question.match(/客户[：:]\s*([^\s，,？?！!]+)/);
      const specificCustomer = customerNameMatch?.[1]?.trim();

      if (specificCustomer) {
        // 查特定客户的记忆 + 订单统计
        const [memRes2, orderRes2] = await Promise.all([
          (supabase.from('customer_memory') as any)
            .select('category, risk_level, content, created_at')
            .eq('customer_id', specificCustomer)
            .order('risk_level')
            .limit(5),
          (supabase.from('orders') as any)
            .select('id, lifecycle_status, quantity')
            .eq('customer_name', specificCustomer)
            .limit(100),
        ]);
        if (memRes2.data && memRes2.data.length > 0) {
          context.push(`\n⚡ 客户「${specificCustomer}」记忆卡片（${memRes2.data.length}条）：`);
          for (const m of memRes2.data) {
            context.push(`  [${m.risk_level === 'high' ? '🔴' : m.risk_level === 'medium' ? '🟡' : '🟢'}${m.category}] ${m.content}`);
          }
        }
        if (orderRes2.data && orderRes2.data.length > 0) {
          const activeOrders = orderRes2.data.filter((o: any) => !['已完成', '已取消', 'completed', 'cancelled'].includes(o.lifecycle_status || '')).length;
          const totalQty = orderRes2.data.reduce((s: number, o: any) => s + (o.quantity || 0), 0);
          context.push(`\n👥 ${specificCustomer}：共 ${orderRes2.data.length} 单，${activeOrders} 单进行中，累计 ${totalQty} 件`);
        }
      } else {
        // 泛化客户概览
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
    }

    // ═══ 4. 超期/风险 ═══
    if (question.includes('超期') || question.includes('风险') || question.includes('逾期') || question.includes('问题') || question.includes('危险')) {
      const { data: overdue } = await (supabase.from('milestones') as any)
        .select('name, due_at, owner_role, orders!inner(order_no, customer_name)')
        .in('status', ['in_progress', '进行中'])
        .lt('due_at', new Date().toISOString())
        .order('due_at').limit(10);
      if (overdue && overdue.length > 0) {
        context.push(`\n⚠ 当前超期节点（${overdue.length}个）：`);
        for (const m of overdue as any[]) {
          const daysAgo = Math.floor((Date.now() - new Date(m.due_at).getTime()) / 86400000);
          context.push(`  ${m.orders?.order_no}-${m.name}（${m.owner_role || '未分配'}，超期${daysAgo}天）`);
        }
      } else {
        context.push('\n✅ 当前无超期节点。');
      }
    }

    // ═══ 5. 今日待办（携带出去，增强上下文） ═══
    if (question.includes('今天') || question.includes('今日') || question.includes('待办') || question.includes('我的')) {
      const today = new Date().toISOString().slice(0, 10);
      const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

      // 按角色过滤
      const roleFilter = primaryRole === 'admin' ? {} : { owner_role: primaryRole };
      let query = (supabase.from('milestones') as any)
        .select('name, owner_role, due_at, orders!inner(order_no, customer_name)')
        .gte('due_at', today + 'T00:00:00')
        .lt('due_at', tomorrow + 'T23:59:59')
        .not('status', 'in', '("done","已完成")');
      if (roleFilter.owner_role) query = query.eq('owner_role', roleFilter.owner_role);
      const { data: todayDue } = await query.limit(10);

      context.push(`\n📋 今日到期（${today}）：`);
      if (todayDue && todayDue.length > 0) {
        for (const m of todayDue as any[]) {
          context.push(`  ${m.orders?.order_no}【${m.orders?.customer_name}】- ${m.name}（${m.owner_role}）`);
        }
      } else {
        context.push('  今日无到期节点。');
      }
    }

    // ═══ 6. 工厂档案 ═══
    if (question.includes('工厂') || question.includes('产能') || question.includes('factory') || question.includes('供应商')) {
      const { data: factories } = await (supabase.from('factories') as any)
        .select('factory_name, worker_count, monthly_capacity, product_categories, avg_delay_days, qc_pass_rate')
        .is('deleted_at', null).limit(20);
      if (factories && factories.length > 0) {
        context.push(`\n🏭 工厂档案（${factories.length}家）：`);
        for (const f of factories as any[]) {
          const parts = [`${f.factory_name}`, `${f.worker_count || '?'}人`, `月产${f.monthly_capacity || '?'}件`];
          if (f.avg_delay_days) parts.push(`历史延期${f.avg_delay_days}天`);
          if (f.qc_pass_rate) parts.push(`QC通过率${f.qc_pass_rate}%`);
          if (f.product_categories?.length > 0) parts.push(f.product_categories.slice(0, 2).join('/'));
          context.push(`  ${parts.join(' | ')}`);
        }
      }
    }

    // ═══ 7. 财务类查询 ═══
    if (question.includes('收款') || question.includes('付款') || question.includes('尾款') || question.includes('定金') || question.includes('逾期')) {
      const { data: overduePayments } = await (supabase.from('order_financials') as any)
        .select('balance_status, balance_amount, balance_due_date, orders!inner(order_no, customer_name)')
        .eq('balance_status', 'overdue')
        .limit(10);
      if (overduePayments && overduePayments.length > 0) {
        context.push(`\n💰 逾期尾款（${overduePayments.length}单）：`);
        for (const p of overduePayments as any[]) {
          context.push(`  ${p.orders?.order_no}【${p.orders?.customer_name}】¥${p.balance_amount || '?'}（截止${p.balance_due_date?.slice(0, 10) || '?'}）`);
        }
      }
    }

    // ═══ 8. 兜底统计 ═══
    if (context.length === 0) {
      const { data: orders } = await (supabase.from('orders') as any)
        .select('id, lifecycle_status').limit(500);
      const total = (orders || []).length;
      const active = (orders || []).filter((o: any) => !['已完成', '已取消', '已复盘', 'completed', 'cancelled'].includes(o.lifecycle_status || '')).length;
      context.push(`系统共 ${total} 个订单，${active} 个进行中。`);
    }

    // ═══ 调用 Claude（多轮对话） ═══
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic();

    const { buildIndustryPrompt } = await import('@/lib/agent/industryKnowledge');

    // 角色专属提示
    const rolePromptExtra = getRolePrompt(primaryRole);

    const systemPrompt = `你是「绮陌服饰智能系统」的 AI 业务助手，名字叫"小绮"。

**你的身份**：10年外贸服装行业专家 + 公司内部知识专家。

**你的能力**：
1. 服装外贸专业知识：面料（克重/成分/缩水率/色牢度）、工艺（印花/绣花/洗水/涂层）、贸易术语（FOB/DDP/CIF/EXW/L/C）、报关（HS编码/原产地证/商检/海关）、物流（海运/空运/快递/LCL/FCL）
2. 帮业务员组织专业的客户回复邮件（中英双版）
3. 查询订单状态和进度分析
4. 分析风险并给出具体可执行的建议
5. 解读客户画像记忆（审批速度/付款习惯/沟通风格）

**回复规则**：
- 简洁专业，用中文。使用 Markdown 格式：**粗体**、分点列表、### 小标题
- 帮写邮件时，给出中英文两个版本
- 涉及具体订单数据，只用系统提供的数据，不编造
- 涉及不确定的专业知识，说明"建议进一步确认"
- 回复要有行业深度，让用户感受到专业性
- 回复要简明，重要结论放最前面

${rolePromptExtra}

${buildIndustryPrompt()}

当前用户：${userName}，角色：${userRoles.join('/')}`;

    // 构建多轮对话消息
    const recentHistory = (history || []).slice(-8); // 最近 8 条
    const claudeMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    for (const msg of recentHistory) {
      claudeMessages.push({
        role: msg.role === 'agent' ? 'assistant' : 'user',
        content: msg.content,
      });
    }

    // 当前消息（带系统数据）
    claudeMessages.push({
      role: 'user',
      content: context.length > 0
        ? `用户问题：${question}\n\n系统实时数据：\n${context.join('\n')}`
        : `用户问题：${question}`,
    });

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1600,
      system: systemPrompt,
      messages: claudeMessages,
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

/**
 * 根据角色生成专属系统提示补充
 */
function getRolePrompt(role: string): string {
  switch (role) {
    case 'sales':
      return `**当前用户角色（业务）**：重点关注客户关系、交期确认、产前样跟进、邮件回复。遇到订单问题时优先建议如何向客户沟通，语气要专业体贴。`;
    case 'merchandiser':
      return `**当前用户角色（跟单）**：重点关注生产进度、节点完成情况、日报提交、工厂协调。遇到节点超期时给出具体催办话术。`;
    case 'procurement':
      return `**当前用户角色（采购）**：重点关注原辅料采购、供应商选择、BOM确认、配色辅料同步下单。提醒面料和辅料要同步启动，避免卡单。`;
    case 'finance':
      return `**当前用户角色（财务）**：重点关注收款状态、定金/尾款到账情况、毛利率预警、逾期付款跟催。`;
    case 'qc':
      return `**当前用户角色（品控）**：重点关注 QC 预约、验货标准（AQL）、常见质量问题（色牢度/尺寸/工艺）、验货报告填写。`;
    case 'production':
    case 'production_manager':
      return `**当前用户角色（生产/生产主管）**：重点关注生产进度、产能计划、品质异常、日报、出厂节点。`;
    case 'admin':
    case 'admin_assistant':
      return `**当前用户角色（管理/助理）**：可查看所有角色视角，回复时可涵盖多部门协调建议。`;
    default:
      return '';
  }
}
