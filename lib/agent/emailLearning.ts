/**
 * 邮件学习系统 — 从历史邮件中提取客户沟通画像
 *
 * 分析邮件历史，学习每个客户的：
 * 1. 沟通频率和响应速度
 * 2. 关注点和常见问题
 * 3. 决策模式（快/慢/犹豫）
 * 4. 语言偏好和沟通风格
 * 5. 季节性订单规律
 */

export interface CustomerEmailProfile {
  customerName: string;
  emailDomain: string;
  totalEmails: number;
  avgResponseHours: number;    // 平均回复时间（小时）
  communicationStyle: string;  // 'formal' | 'casual' | 'mixed'
  topTopics: string[];         // 最常讨论的话题
  complaintHistory: string[];  // 投诉/不满记录
  seasonalPattern: string;     // 季节性规律
  decisionSpeed: 'fast' | 'normal' | 'slow';
  riskFlags: string[];
}

/**
 * 批量分析客户邮件画像（用 Claude）
 */
export async function buildEmailBasedProfile(
  supabase: any,
  customerName: string,
): Promise<CustomerEmailProfile | null> {
  // 获取该客户的所有邮件
  const { data: emails } = await supabase
    .from('mail_inbox')
    .select('from_email, subject, raw_body, received_at')
    .eq('customer_id', customerName)
    .order('received_at', { ascending: false })
    .limit(50);

  if (!emails || emails.length < 3) return null;

  const emailDomain = emails[0]?.from_email?.split('@')[1] || '';

  // 构建邮件摘要（控制 token）
  const emailSummary = emails.slice(0, 20).map((e: any, i: number) =>
    `${i + 1}. [${e.received_at?.slice(0, 10)}] From: ${e.from_email}\n   Subject: ${e.subject}\n   ${(e.raw_body || '').slice(0, 200)}`
  ).join('\n\n');

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic();

    const prompt = `分析以下客户（${customerName}）的邮件历史，提取沟通画像。

邮件记录（${emails.length}封，显示最近20封）：
${emailSummary}

请分析并返回JSON：
{
  "avgResponseHours": 预估平均回复时间（小时），
  "communicationStyle": "formal/casual/mixed",
  "topTopics": ["最常讨论的3-5个话题"],
  "complaintHistory": ["投诉或不满的摘要，如果有"],
  "seasonalPattern": "季节性订单规律描述",
  "decisionSpeed": "fast/normal/slow",
  "riskFlags": ["风险标记，如'经常临时改数量'、'付款常拖延'等"]
}
只返回JSON。`;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514', max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const profile: CustomerEmailProfile = {
        customerName,
        emailDomain,
        totalEmails: emails.length,
        avgResponseHours: parsed.avgResponseHours || 24,
        communicationStyle: parsed.communicationStyle || 'mixed',
        topTopics: parsed.topTopics || [],
        complaintHistory: parsed.complaintHistory || [],
        seasonalPattern: parsed.seasonalPattern || '无明显规律',
        decisionSpeed: parsed.decisionSpeed || 'normal',
        riskFlags: parsed.riskFlags || [],
      };

      // 存入客户记忆
      await supabase.from('customer_memory').insert({
        customer_id: customerName,
        source_type: 'email_learning',
        content: `邮件画像：沟通风格${profile.communicationStyle}，决策速度${profile.decisionSpeed}，常谈话题：${profile.topTopics.join('、')}。${profile.riskFlags.length > 0 ? '风险：' + profile.riskFlags.join('、') : ''}`,
        category: 'general',
        risk_level: profile.riskFlags.length >= 2 ? 'high' : profile.riskFlags.length >= 1 ? 'medium' : 'low',
        content_json: profile,
      }).catch(() => {});

      return profile;
    }
  } catch (err: any) {
    console.error('[emailLearning]', err?.message);
  }

  return null;
}

/**
 * 批量学习所有客户的邮件画像（在 Agent 周报中调用）
 */
export async function learnAllCustomerProfiles(supabase: any): Promise<number> {
  // 找到有邮件记录的客户
  const { data: customers } = await supabase
    .from('mail_inbox')
    .select('customer_id')
    .not('customer_id', 'is', null);

  const uniqueCustomers = [...new Set((customers || []).map((c: any) => c.customer_id))];
  let learned = 0;

  for (const customer of uniqueCustomers.slice(0, 10)) { // 每次最多10个客户
    // 检查是否最近7天已经分析过
    const { data: recent } = await supabase
      .from('customer_memory')
      .select('id')
      .eq('customer_id', customer)
      .eq('source_type', 'email_learning')
      .gte('created_at', new Date(Date.now() - 7 * 86400000).toISOString())
      .limit(1);

    if (recent && recent.length > 0) continue; // 最近分析过，跳过

    const profile = await buildEmailBasedProfile(supabase, customer);
    if (profile) learned++;
  }

  return learned;
}
