/**
 * 统一知识图谱 — 整合客户+工厂+订单+邮件的全维度记忆
 *
 * 为 AI 推理提供完整上下文，不再分散查询多个表
 */

export interface UnifiedContext {
  // 客户维度
  customer: {
    name: string;
    totalOrders: number;
    avgConfirmDays: number;
    delayRate: number;
    riskLevel: string;
    recentMemories: string[];
    emailPatterns: string[];
  } | null;

  // 工厂维度
  factory: {
    name: string;
    capacity: number | null;
    utilization: number;
    onTimeRate: number;
    activeOrders: number;
    categories: string[];
  } | null;

  // 订单维度
  order: {
    orderNo: string;
    quantity: number;
    daysLeft: number;
    overdueNodes: string[];
    completedRate: number;
    agentHistory: string[];  // Agent 建议执行记录
  } | null;

  // 邮件维度
  recentEmails: Array<{
    subject: string;
    from: string;
    date: string;
    changes: string[];
  }>;
}

/**
 * 一次性构建订单的全维度上下文
 */
export async function buildUnifiedContext(
  supabase: any,
  orderId: string,
): Promise<UnifiedContext> {
  const ctx: UnifiedContext = { customer: null, factory: null, order: null, recentEmails: [] };

  // 获取订单基础信息
  const { data: order } = await supabase
    .from('orders')
    .select('id, order_no, customer_name, factory_name, quantity, factory_date, incoterm')
    .eq('id', orderId).single();
  if (!order) return ctx;

  // 订单维度
  const { data: milestones } = await supabase
    .from('milestones')
    .select('name, status, due_at, completed_at')
    .eq('order_id', orderId);
  const ms = milestones || [];
  const done = ms.filter((m: any) => m.status === 'done' || m.status === '已完成').length;
  const overdue = ms.filter((m: any) => m.due_at && new Date(m.due_at) < new Date() && m.status !== 'done' && m.status !== '已完成');
  const daysLeft = order.factory_date ? Math.ceil((new Date(order.factory_date).getTime() - Date.now()) / 86400000) : 0;

  // Agent 历史
  const { data: agentHistory } = await supabase
    .from('agent_actions')
    .select('title, status, action_type')
    .eq('order_id', orderId)
    .eq('status', 'executed')
    .order('executed_at', { ascending: false })
    .limit(5);

  ctx.order = {
    orderNo: order.order_no,
    quantity: order.quantity || 0,
    daysLeft,
    overdueNodes: overdue.map((m: any) => m.name),
    completedRate: ms.length > 0 ? Math.round((done / ms.length) * 100) : 0,
    agentHistory: (agentHistory || []).map((a: any) => `${a.action_type}: ${a.title}`),
  };

  // 客户维度
  if (order.customer_name) {
    const { data: custOrders } = await supabase
      .from('orders').select('id').eq('customer_name', order.customer_name);
    const { data: memories } = await supabase
      .from('customer_memory')
      .select('content, risk_level')
      .eq('customer_id', order.customer_name)
      .order('created_at', { ascending: false })
      .limit(5);
    const { data: emails } = await supabase
      .from('mail_inbox')
      .select('subject, from_email, received_at')
      .eq('customer_id', order.customer_name)
      .order('received_at', { ascending: false })
      .limit(3);

    ctx.customer = {
      name: order.customer_name,
      totalOrders: (custOrders || []).length,
      avgConfirmDays: 7,
      delayRate: 0,
      riskLevel: 'low',
      recentMemories: (memories || []).map((m: any) => m.content),
      emailPatterns: (emails || []).map((e: any) => e.subject),
    };

    ctx.recentEmails = (emails || []).map((e: any) => ({
      subject: e.subject, from: e.from_email, date: e.received_at, changes: [],
    }));
  }

  // 工厂维度
  if (order.factory_name) {
    const { data: factory } = await supabase
      .from('factories')
      .select('monthly_capacity, product_categories')
      .eq('factory_name', order.factory_name).is('deleted_at', null).single();
    const { data: factOrders } = await supabase
      .from('orders').select('quantity')
      .eq('factory_name', order.factory_name)
      .in('lifecycle_status', ['执行中', 'running', 'active', '已生效']);
    const activeQty = (factOrders || []).reduce((s: number, o: any) => s + (o.quantity || 0), 0);

    ctx.factory = {
      name: order.factory_name,
      capacity: factory?.monthly_capacity || null,
      utilization: factory?.monthly_capacity ? Math.round((activeQty / factory.monthly_capacity) * 100) : 0,
      onTimeRate: 0,
      activeOrders: (factOrders || []).length,
      categories: factory?.product_categories || [],
    };
  }

  return ctx;
}

/**
 * 将统一上下文转为 AI 可读的文本
 */
export function contextToPrompt(ctx: UnifiedContext): string {
  const parts: string[] = [];

  if (ctx.order) {
    parts.push(`【订单】${ctx.order.orderNo}：${ctx.order.quantity}件，完成${ctx.order.completedRate}%，剩余${ctx.order.daysLeft}天`);
    if (ctx.order.overdueNodes.length > 0) parts.push(`  超期节点：${ctx.order.overdueNodes.join('、')}`);
    if (ctx.order.agentHistory.length > 0) parts.push(`  Agent历史：${ctx.order.agentHistory.slice(0, 3).join('；')}`);
  }

  if (ctx.customer) {
    parts.push(`【客户】${ctx.customer.name}：${ctx.customer.totalOrders}单历史，风险${ctx.customer.riskLevel}`);
    if (ctx.customer.recentMemories.length > 0) parts.push(`  记忆：${ctx.customer.recentMemories.slice(0, 2).join('；')}`);
    if (ctx.customer.emailPatterns.length > 0) parts.push(`  最近邮件：${ctx.customer.emailPatterns.slice(0, 2).join('；')}`);
  }

  if (ctx.factory) {
    parts.push(`【工厂】${ctx.factory.name}：产能${ctx.factory.utilization}%，${ctx.factory.activeOrders}单在手`);
  }

  return parts.join('\n');
}
