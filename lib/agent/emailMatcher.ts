/**
 * 邮件 AI 智能匹配 — 不依赖 PO 号
 *
 * 匹配链路：
 * 1. 发件人邮箱 → 匹配客户（历史邮件关联）
 * 2. 邮件内容 → Claude 提取关键信息（产品/数量/交期/要求变更）
 * 3. 关键信息 → 匹配具体订单
 * 4. 对比订单 → 检测差异/遗漏
 * 5. 生成提醒 → 通知业务员
 */

export interface EmailAnalysis {
  // 提取的信息
  customerName: string | null;
  poNumber: string | null;
  productHints: string[];       // 产品关键词（yoga pants, jacket等）
  quantityMentioned: number | null;
  deliveryMentioned: string | null;
  priceChange: boolean;
  sampleRelated: boolean;
  urgentLevel: 'normal' | 'important' | 'urgent';

  // 变更检测
  changes: Array<{
    type: 'quantity' | 'delivery' | 'color' | 'size' | 'cancel' | 'add_order' | 'sample_feedback' | 'other';
    description: string;
  }>;

  // 匹配结果
  matchedOrderId: string | null;
  matchedOrderNo: string | null;
  matchConfidence: 'high' | 'medium' | 'low';

  // 建议动作
  suggestedAction: string | null;
}

/**
 * 用 Claude 分析邮件内容
 */
export async function analyzeEmailWithAI(
  fromEmail: string,
  subject: string,
  body: string,
  customerContext: string,  // 已知客户和活跃订单列表
): Promise<EmailAnalysis> {
  const defaultResult: EmailAnalysis = {
    customerName: null, poNumber: null, productHints: [],
    quantityMentioned: null, deliveryMentioned: null,
    priceChange: false, sampleRelated: false, urgentLevel: 'normal',
    changes: [], matchedOrderId: null, matchedOrderNo: null,
    matchConfidence: 'low', suggestedAction: null,
  };

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic();

    const prompt = `你是外贸服装订单管理AI。分析以下客户邮件，提取订单相关信息。

发件人：${fromEmail}
主题：${subject}
正文：
${body.slice(0, 3000)}

系统中当前活跃的客户和订单：
${customerContext}

请分析并返回JSON：
{
  "customerName": "匹配到的客户名（从发件人或内容判断）",
  "poNumber": "PO号（如果邮件中提到）",
  "productHints": ["产品关键词，如yoga pants, jacket"],
  "quantityMentioned": 数量（如果提到），
  "deliveryMentioned": "交期（如果提到）",
  "priceChange": false,
  "sampleRelated": false,
  "urgentLevel": "normal/important/urgent",
  "changes": [
    {"type": "quantity/delivery/color/size/cancel/add_order/sample_feedback/other", "description": "变更描述"}
  ],
  "matchedOrderNo": "最可能匹配的订单号",
  "matchConfidence": "high/medium/low",
  "suggestedAction": "建议业务员做什么（中文，一句话）"
}

注意：
- 如果邮件内容和订单无关（如广告、通知），返回空结果
- customerName 优先从发件人域名和系统客户列表匹配
- 即使没有PO号，也尝试通过产品描述+客户名匹配订单
- changes 只记录实际的变更请求，不记录普通沟通
只返回JSON。`;

    const response = await client.messages.create(
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      },
      { signal: AbortSignal.timeout(30_000) }, // P1 修复：30s 超时
    );

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        ...defaultResult,
        customerName: parsed.customerName || null,
        poNumber: parsed.poNumber || null,
        productHints: parsed.productHints || [],
        quantityMentioned: parsed.quantityMentioned || null,
        deliveryMentioned: parsed.deliveryMentioned || null,
        priceChange: parsed.priceChange || false,
        sampleRelated: parsed.sampleRelated || false,
        urgentLevel: parsed.urgentLevel || 'normal',
        changes: parsed.changes || [],
        matchedOrderNo: parsed.matchedOrderNo || null,
        matchConfidence: parsed.matchConfidence || 'low',
        suggestedAction: parsed.suggestedAction || null,
      };
    }
  } catch (err: any) {
    console.error('[emailMatcher] AI analysis failed:', err?.message);
  }

  return defaultResult;
}

/**
 * 构建客户上下文（供 AI 匹配用）
 */
export async function buildCustomerContext(supabase: any): Promise<string> {
  // 获取所有活跃订单的客户和基本信息
  const { data: orders } = await supabase
    .from('orders')
    .select('order_no, customer_name, quantity, factory_name, po_number, order_type, factory_date')
    .in('lifecycle_status', ['执行中', 'running', 'active', '已生效', '草稿', 'draft'])
    .order('created_at', { ascending: false })
    .limit(50);

  if (!orders || orders.length === 0) return '暂无活跃订单';

  // 按客户分组
  const customerOrders: Record<string, string[]> = {};
  for (const o of orders) {
    const key = o.customer_name || '未知';
    if (!customerOrders[key]) customerOrders[key] = [];
    customerOrders[key].push(
      `${o.order_no}(PO:${o.po_number || '无'}, ${o.quantity || '?'}件, ${o.order_type}, 出厂:${o.factory_date || '未设'})`
    );
  }

  return Object.entries(customerOrders)
    .map(([customer, orders]) => `客户「${customer}」: ${orders.join(', ')}`)
    .join('\n');
}

/**
 * 通过发件人邮箱域名匹配客户
 */
export function matchCustomerByEmail(
  fromEmail: string,
  customerEmails: Array<{ customer_name: string; email_domain: string }>
): string | null {
  const domain = fromEmail.split('@')[1]?.toLowerCase();
  if (!domain) return null;

  for (const ce of customerEmails) {
    if (ce.email_domain && domain.includes(ce.email_domain.toLowerCase())) {
      return ce.customer_name;
    }
  }
  return null;
}
