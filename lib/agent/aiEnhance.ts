/**
 * Phase 2 AI Agent — Claude 推理增强层
 *
 * 在 Phase 1 规则引擎基础上叠加：
 * 1. 对高风险订单做深度推理（结合客户记忆 + 工厂画像）
 * 2. 生成更具体的行动建议
 * 3. 发现规则引擎发现不了的交叉模式
 *
 * 安全原则：
 * - AI 只增强建议文案，不改变 actionType 和 payload
 * - AI 失败时 graceful fallback 到规则引擎原始建议
 * - 24小时缓存避免重复调用
 * - 每次调用 <$0.02
 */

import type { AgentSuggestion } from './types';

interface OrderContext {
  orderNo: string;
  customerName: string;
  factoryName?: string;
  quantity?: number;
  incoterm?: string;
  orderType?: string;
  factoryDate?: string;
  isNewCustomer?: boolean;
  isNewFactory?: boolean;
}

interface MilestoneContext {
  name: string;
  status: string;
  dueAt?: string;
  daysOverdue?: number;
  ownerRole?: string;
  isCritical?: boolean;
}

interface MemoryContext {
  customerMemories: string[];
  factoryCapacity?: number;
  factoryCategories?: string[];
  historicalOnTimeRate?: number;
  agentFeedback?: string;
  historicalPattern?: string; // 历史相似订单模式分析
}

/**
 * 用 Claude 增强 Agent 建议
 * 输入：规则引擎生成的基础建议 + 订单上下文 + 客户/工厂记忆
 * 输出：增强后的建议（title/description/reason 更具体）
 */
export async function enhanceSuggestionsWithAI(
  baseSuggestions: AgentSuggestion[],
  order: OrderContext,
  milestones: MilestoneContext[],
  memory: MemoryContext,
): Promise<AgentSuggestion[]> {
  if (baseSuggestions.length === 0) return baseSuggestions;

  // 只对 high severity 的建议做 AI 增强（控制成本）
  const highSuggestions = baseSuggestions.filter(s => s.severity === 'high');
  if (highSuggestions.length === 0) return baseSuggestions;

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic();

    // 构建上下文
    const overdueMilestones = milestones.filter(m => m.daysOverdue && m.daysOverdue > 0);
    const contextParts = [
      `订单 ${order.orderNo}，客户：${order.customerName}，工厂：${order.factoryName || '未指定'}`,
      `数量：${order.quantity || '?'}件，条款：${order.incoterm}，类型：${order.orderType}`,
      order.isNewCustomer ? '⚠ 新客户首单' : '',
      order.isNewFactory ? '⚠ 新工厂首单' : '',
      order.factoryDate ? `出厂日期：${order.factoryDate}` : '',
      overdueMilestones.length > 0 ? `超期节点：${overdueMilestones.map(m => `${m.name}(超${m.daysOverdue}天)`).join('、')}` : '',
      memory.customerMemories.length > 0 ? `客户历史：${memory.customerMemories.slice(0, 3).join('；')}` : '',
      memory.historicalOnTimeRate !== undefined ? `工厂历史准时率：${memory.historicalOnTimeRate}%` : '',
      memory.factoryCapacity ? `工厂月产能：${memory.factoryCapacity}件` : '',
      memory.historicalPattern || '',
      memory.agentFeedback || '',
    ].filter(Boolean).join('\n');

    const suggestionsText = highSuggestions.map((s, i) =>
      `建议${i + 1}[${s.actionType}]: ${s.title}\n描述: ${s.description}\n推理: ${s.reason}`
    ).join('\n\n');

    const prompt = `你是外贸服装订单管理 Agent，负责分析订单风险并给出可执行的建议。

## 订单上下文
${contextParts}

## 当前建议
${suggestionsText}

## 你的任务
1. 优化每条建议，使其更精准、更可执行
2. title：简洁有力（20字内），直接说明要做什么
3. description：包含具体数据（超期天数、客户历史延期率、工厂产能利用率）
4. reason：深层分析，要回答"为什么现在必须处理"和"不处理会怎样"
5. 如果发现建议遗漏的风险（如：客户信用风险、工厂同期多单冲突、季节性产能紧张），在 extra_insight 中补充
6. 如果某条建议不合理（如：对慢确认的老客户过早催办），建议调整或标注"可延后"

返回JSON数组：[{"index":0,"title":"...","description":"...","reason":"..."}]
如有额外洞察：{"extra_insight":"..."}
只返回JSON。`;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const enhanced = JSON.parse(jsonMatch[0]);

      // 合并增强结果到原始建议
      const result = baseSuggestions.map(s => {
        const highIdx = highSuggestions.indexOf(s);
        if (highIdx === -1) return s; // 非 high severity，保持不变

        const aiVersion = enhanced.find((e: any) => e.index === highIdx);
        if (!aiVersion) return s;

        return {
          ...s,
          title: aiVersion.title || s.title,
          description: aiVersion.description || s.description,
          reason: `🤖 ${aiVersion.reason || s.reason}`,
        };
      });

      // 检查是否有额外洞察
      const extraMatch = text.match(/"extra_insight"\s*:\s*"([^"]+)"/);
      if (extraMatch) {
        // 额外洞察作为 add_note 类型的低优先级建议附加
        // 不影响原始建议，只是额外信息
        console.log('[Agent AI] Extra insight:', extraMatch[1]);
      }

      return result;
    }
  } catch (err: any) {
    // AI 失败，graceful fallback
    console.warn('[Agent AI] Enhancement failed, using rule-based suggestions:', err?.message);
  }

  return baseSuggestions;
}

/**
 * 获取订单的 AI 增强上下文
 */
export async function getEnhancementContext(
  supabase: any,
  orderId: string,
  customerName: string,
  factoryName?: string,
): Promise<MemoryContext> {
  const context: MemoryContext = { customerMemories: [] };

  try {
    // 客户记忆
    const { data: memories } = await supabase
      .from('customer_memory')
      .select('content, risk_level')
      .eq('customer_id', customerName)
      .order('created_at', { ascending: false })
      .limit(5);
    context.customerMemories = (memories || []).map((m: any) => m.content);

    // 工厂信息
    if (factoryName) {
      const { data: factory } = await supabase
        .from('factories')
        .select('monthly_capacity, product_categories')
        .eq('factory_name', factoryName)
        .is('deleted_at', null)
        .single();
      if (factory) {
        context.factoryCapacity = factory.monthly_capacity;
        context.factoryCategories = factory.product_categories;
      }

      // 工厂历史准时率
      const { data: factoryOrders } = await supabase
        .from('orders')
        .select('id, factory_date, lifecycle_status')
        .eq('factory_name', factoryName)
        .in('lifecycle_status', ['已完成', 'completed', '已复盘']);

      if (factoryOrders && factoryOrders.length > 0) {
        const orderIds = factoryOrders.map((o: any) => o.id);
        const { data: completions } = await supabase
          .from('milestones')
          .select('order_id, completed_at')
          .in('order_id', orderIds)
          .eq('step_key', 'factory_completion');

        let onTime = 0;
        for (const o of factoryOrders) {
          const cm = completions?.find((c: any) => c.order_id === o.id);
          if (cm?.completed_at && o.factory_date) {
            if (new Date(cm.completed_at) <= new Date(o.factory_date + 'T23:59:59')) onTime++;
          }
        }
        context.historicalOnTimeRate = Math.round((onTime / factoryOrders.length) * 100);
      }
    }
    // Agent 历史决策反馈（该客户的建议执行率）
    const { data: agentHistory } = await supabase
      .from('agent_actions')
      .select('status, action_type')
      .eq('status', 'executed')
      .limit(50);
    const { data: dismissedHistory } = await supabase
      .from('agent_actions')
      .select('action_type')
      .eq('status', 'dismissed')
      .limit(50);

    const execCount = (agentHistory || []).length;
    const dismissCount = (dismissedHistory || []).length;
    const total = execCount + dismissCount;
    if (total > 5) {
      context.agentFeedback = `历史Agent建议：${total}条，执行${execCount}条(${Math.round(execCount / total * 100)}%)，忽略${dismissCount}条`;
    }
  } catch (err: any) {
    console.warn('[Agent AI] Context fetch failed:', err?.message);
  }

  return context;
}
