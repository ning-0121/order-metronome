/**
 * 业务员每日邮件简报 — AI 整理当天工作重点
 *
 * 6个板块：
 * 1. 昨日新邮件（按客户分组+AI摘要）
 * 2. 紧急待处理
 * 3. 今日跟进（到期节点+邮件跟进）
 * 4. 执行偏差（从对照检查）
 * 5. AI优先级建议
 * 6. 待审回复草稿
 */

import { AGENT_FLAGS } from './featureFlags';

export interface BriefingContent {
  newEmails: Array<{
    customer: string;
    emails: Array<{ subject: string; from: string; date: string; summary: string }>;
  }>;
  urgentItems: Array<{ description: string; customer: string; orderId: string | null }>;
  followUpsDue: Array<{ customer: string; orderNo: string; milestone: string; dueDate: string }>;
  complianceIssues: Array<{ type: string; description: string; severity: string; orderId: string | null }>;
  prioritySuggestions: Array<{ rank: number; action: string; reason: string }>;
  draftReplies: Array<{ emailSubject: string; draftPreview: string }>;
  /** 邮件-订单差异（来自 email_order_diffs 表，仅 status='open' 的） */
  emailOrderDiffs?: Array<{
    diffId: string;
    orderId: string;
    orderNo: string;
    customer: string;
    field: string;
    emailValue: string;
    orderValue: string;
    severity: 'high' | 'medium' | 'low';
    suggestion: string;
    detectedAt: string;
  }>;
}

/**
 * 为单个业务员生成今日简报
 */
export async function generateBriefingForUser(
  supabase: any,
  userId: string,
  userName: string,
): Promise<{
  content: BriefingContent;
  summaryText: string;
  totalEmails: number;
  urgentCount: number;
  complianceCount: number;
} | null> {
  if (!AGENT_FLAGS.dailyBriefing()) return null;

  const yesterdayStart = new Date();
  yesterdayStart.setHours(yesterdayStart.getHours() - 24);
  const todayStr = new Date().toISOString().slice(0, 10);

  // 1. 获取该业务员负责的订单
  const { data: myOrders } = await supabase
    .from('orders')
    .select('id, order_no, customer_name, quantity, factory_date, etd')
    .eq('owner_user_id', userId)
    .in('lifecycle_status', ['执行中', 'running', 'active', '已生效'])
    .limit(50);

  if (!myOrders || myOrders.length === 0) return null;

  const myCustomers = [...new Set(myOrders.map((o: any) => o.customer_name).filter(Boolean))];

  // 2. 获取昨日新邮件（客户来件）
  const { data: newEmails } = await supabase
    .from('mail_inbox')
    .select('id, from_email, subject, raw_body, received_at, customer_id, order_id')
    .in('customer_id', myCustomers)
    .gte('received_at', yesterdayStart.toISOString())
    .not('from_email', 'ilike', '%@qimoclothing.com')
    .order('received_at', { ascending: false })
    .limit(30);

  // 3. 获取今日到期节点
  const orderIds = myOrders.map((o: any) => o.id);
  const { data: todayMilestones } = await supabase
    .from('milestones')
    .select('id, name, due_at, status, order_id')
    .in('order_id', orderIds)
    .in('status', ['in_progress', '进行中', 'pending', '待开始'])
    .lte('due_at', new Date(Date.now() + 86400000).toISOString())
    .order('due_at', { ascending: true })
    .limit(20);

  // 4. 获取对照检查发现
  const { data: complianceIssues } = await supabase
    .from('compliance_findings')
    .select('id, finding_type, title, description, severity, order_id')
    .eq('salesperson_user_id', userId)
    .eq('status', 'open')
    .limit(10);

  // 5. 获取待审回复草稿
  const { data: draftNotifs } = await supabase
    .from('notifications')
    .select('title, message')
    .eq('user_id', userId)
    .eq('type', 'email_draft')
    .eq('status', 'unread')
    .limit(5);

  // 5.5 获取邮件-订单差异（仅未解决的）
  const { data: openDiffs } = await supabase
    .from('email_order_diffs')
    .select('id, order_id, field, email_value, order_value, severity, suggestion, detected_at')
    .in('order_id', orderIds)
    .eq('status', 'open')
    .order('detected_at', { ascending: false })
    .limit(20);

  // 按客户分组邮件
  const emailsByCustomer = new Map<string, any[]>();
  for (const email of newEmails || []) {
    const customer = email.customer_id || '未知客户';
    const list = emailsByCustomer.get(customer) || [];
    list.push(email);
    emailsByCustomer.set(customer, list);
  }

  // AI 生成摘要和优先级
  let aiResult: any = null;
  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic();

    const emailContext = Array.from(emailsByCustomer.entries())
      .map(([customer, emails]) =>
        `【${customer}】${emails.length}封\n${emails.map((e: any) => `  - ${e.subject}`).join('\n')}`
      ).join('\n');

    const milestoneContext = (todayMilestones || [])
      .map((m: any) => {
        const order = myOrders.find((o: any) => o.id === m.order_id);
        return `- ${order?.order_no || '?'} / ${m.name} / 到期:${m.due_at?.slice(0, 10)}`;
      }).join('\n');

    const complianceContext = (complianceIssues || [])
      .map((c: any) => `- [${c.severity}] ${c.description}`).join('\n');

    const prompt = `你是外贸业务员${userName}的AI助手，生成今日工作简报。

## 昨日新邮件（${(newEmails || []).length}封）：
${emailContext || '无新邮件'}

## 今日到期节点：
${milestoneContext || '无到期节点'}

## 执行偏差问题：
${complianceContext || '无'}

请生成简报，返回JSON：
{
  "customerSummaries": [{"customer":"客户名","summary":"1-2句话概括该客户邮件要点"}],
  "urgentItems": [{"description":"需立即处理的事项","customer":"客户名"}],
  "prioritySuggestions": [{"rank":1,"action":"具体做什么","reason":"为什么优先"}],
  "plainTextSummary": "5-8行简短摘要（用于微信推送）"
}
只返回JSON。`;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const match = text.match(/\{[\s\S]*\}/);
    if (match) aiResult = JSON.parse(match[0]);
  } catch (err) {
    console.error('[daily-briefing] AI error:', err);
  }

  // 组装简报
  const content: BriefingContent = {
    newEmails: Array.from(emailsByCustomer.entries()).map(([customer, emails]) => ({
      customer,
      emails: emails.map((e: any) => ({
        subject: e.subject,
        from: e.from_email,
        date: e.received_at?.slice(0, 16),
        summary: aiResult?.customerSummaries?.find((s: any) => s.customer === customer)?.summary || '',
      })),
    })),
    urgentItems: (aiResult?.urgentItems || []).map((item: any) => ({
      description: item.description,
      customer: item.customer || '',
      orderId: null,
    })),
    followUpsDue: (todayMilestones || []).map((m: any) => {
      const order = myOrders.find((o: any) => o.id === m.order_id);
      return {
        customer: order?.customer_name || '',
        orderNo: order?.order_no || '',
        milestone: m.name,
        dueDate: m.due_at?.slice(0, 10),
      };
    }),
    complianceIssues: (complianceIssues || []).map((c: any) => ({
      type: c.finding_type,
      description: c.description,
      severity: c.severity,
      orderId: c.order_id,
    })),
    prioritySuggestions: aiResult?.prioritySuggestions || [],
    draftReplies: (draftNotifs || []).map((n: any) => ({
      emailSubject: n.title?.replace('✉️ AI已草拟回复 — ', '') || '',
      draftPreview: n.message?.slice(0, 100) || '',
    })),
    emailOrderDiffs: (openDiffs || []).map((d: any) => {
      const order = myOrders.find((o: any) => o.id === d.order_id);
      return {
        diffId: d.id,
        orderId: d.order_id,
        orderNo: order?.order_no || '?',
        customer: order?.customer_name || '',
        field: d.field,
        emailValue: d.email_value || '',
        orderValue: d.order_value || '',
        severity: d.severity,
        suggestion: d.suggestion || '',
        detectedAt: d.detected_at?.slice(0, 16) || '',
      };
    }),
  };

  const summaryText = aiResult?.plainTextSummary ||
    `📧 ${(newEmails || []).length}封新邮件，📋 ${(todayMilestones || []).length}个今日节点，🔍 ${(complianceIssues || []).length}个执行偏差`;

  return {
    content,
    summaryText,
    totalEmails: (newEmails || []).length,
    urgentCount: content.urgentItems.length,
    complianceCount: (complianceIssues || []).length,
  };
}
