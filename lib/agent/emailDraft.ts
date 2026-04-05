/**
 * 邮件草拟回复 — AI 根据订单状态和邮件内容生成回复草稿
 *
 * 不自动发送！生成草稿后通知业务员，业务员审阅修改后自己发送
 */

import { buildUnifiedContext, contextToPrompt } from './knowledgeGraph';

export interface EmailDraft {
  subject: string;
  body: string;
  tone: 'formal' | 'friendly' | 'urgent';
  keyPoints: string[];
}

/**
 * 根据客户邮件 + 订单上下文生成回复草稿
 */
export async function generateEmailDraft(
  supabase: any,
  originalEmail: { from: string; subject: string; body: string },
  orderId: string | null,
  customerName: string | null,
): Promise<EmailDraft | null> {
  try {
    // 构建上下文
    let contextStr = '';
    if (orderId) {
      const ctx = await buildUnifiedContext(supabase, orderId);
      contextStr = contextToPrompt(ctx);
    }

    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic();

    const prompt = `你是一位专业的外贸服装公司业务员。根据以下客户邮件和订单信息，草拟一封回复邮件。

客户来信：
From: ${originalEmail.from}
Subject: ${originalEmail.subject}
Body: ${originalEmail.body.slice(0, 2000)}

订单信息：
${contextStr || '暂无关联订单信息'}

要求：
1. 用英文回复（除非客户用中文）
2. 专业、礼貌、简洁
3. 如果客户问交期，根据订单实际进度回答
4. 如果客户要改数量/颜色，表示会确认后回复
5. 如果是样品反馈，表示感谢并说明下一步
6. 不要承诺具体日期（除非订单信息中有明确数据）
7. 署名用 "Best regards, [Your Name]"

返回JSON：
{
  "subject": "回复主题（Re: 原标题）",
  "body": "邮件正文",
  "tone": "formal/friendly/urgent",
  "keyPoints": ["回复中包含的关键信息点"]
}
只返回JSON。`;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514', max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        subject: parsed.subject || `Re: ${originalEmail.subject}`,
        body: parsed.body || '',
        tone: parsed.tone || 'formal',
        keyPoints: parsed.keyPoints || [],
      };
    }
  } catch (err: any) {
    console.error('[emailDraft]', err?.message);
  }
  return null;
}
