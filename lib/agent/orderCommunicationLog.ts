/**
 * 订单沟通细节记录 — 从邮件中提取每个订单的关键信息
 *
 * 存入 customer_memory 表，归属到客户+订单
 * 业务员换了也不会丢失
 *
 * 提取内容：
 * - 客户对产品的具体要求
 * - 客户确认/修改/投诉记录
 * - 交期讨论和承诺
 * - 价格讨论（仅标记有讨论，不存具体数字）
 * - 样品反馈
 * - 特殊注意事项
 */

export interface CommunicationDetail {
  type: 'requirement' | 'confirmation' | 'change' | 'complaint' | 'delivery' | 'sample' | 'special';
  summary: string;
  date: string;
  fromEmail: string;
  importance: 'high' | 'medium' | 'low';
}

/**
 * 从单封邮件中提取订单相关沟通细节
 */
export async function extractCommunicationDetails(
  subject: string,
  body: string,
  fromEmail: string,
  date: string,
): Promise<CommunicationDetail[]> {
  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic();

    const prompt = `分析以下客户邮件，提取与订单相关的关键沟通细节。

邮件：
From: ${fromEmail}
Date: ${date}
Subject: ${subject}
Body: ${body.slice(0, 2000)}

请提取所有重要的沟通细节，返回JSON数组：
[
  {
    "type": "requirement/confirmation/change/complaint/delivery/sample/special",
    "summary": "一句话描述（中文）",
    "importance": "high/medium/low"
  }
]

type说明：
- requirement: 客户对产品的具体要求（面料、颜色、尺码、工艺等）
- confirmation: 客户确认某事项
- change: 客户要求修改（数量、交期、款式等）
- complaint: 客户不满或投诉
- delivery: 关于交期的讨论
- sample: 关于样品的反馈
- special: 特殊注意事项

如果邮件不包含订单相关内容（广告、问候等），返回空数组 []
只返回JSON数组。`;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514', max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return parsed.map((d: any) => ({
        type: d.type || 'special',
        summary: d.summary || '',
        date,
        fromEmail,
        importance: d.importance || 'medium',
      }));
    }
  } catch {}
  return [];
}

/**
 * 将沟通细节存入客户记忆（归属到客户+订单）
 */
export async function saveCommunicationDetails(
  supabase: any,
  customerName: string,
  orderId: string | null,
  details: CommunicationDetail[],
): Promise<number> {
  let saved = 0;

  const typeLabels: Record<string, string> = {
    requirement: '📋 客户要求',
    confirmation: '✅ 客户确认',
    change: '🔄 变更请求',
    complaint: '⚠️ 客户投诉',
    delivery: '📅 交期沟通',
    sample: '🧪 样品反馈',
    special: '📌 特殊注意',
  };

  for (const detail of details) {
    const content = `${typeLabels[detail.type] || detail.type}：${detail.summary}（${detail.date?.slice(0, 10)} ${detail.fromEmail}）`;

    const { error } = await supabase.from('customer_memory').insert({
      customer_id: customerName,
      order_id: orderId,
      source_type: 'email_communication',
      content,
      category: detail.type === 'complaint' ? 'complaint' : detail.type === 'sample' ? 'sample' : 'general',
      risk_level: detail.importance === 'high' ? 'high' : detail.importance === 'medium' ? 'medium' : 'low',
      content_json: detail,
    });

    if (!error) saved++;
  }

  return saved;
}
