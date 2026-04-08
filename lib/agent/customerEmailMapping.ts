/**
 * 客户邮箱智能识别 — 自动建立 客户↔邮箱域名 映射
 *
 * 核心逻辑：
 * 1. 从已有订单中提取客户名
 * 2. 从邮件 from_email 中提取域名
 * 3. AI 分析邮件内容确认客户归属
 * 4. 建立映射后，后续邮件自动识别客户
 */

/**
 * 从邮件地址推断客户
 * 优先用已建立的映射，其次用 AI
 */
export async function identifyCustomerFromEmail(
  supabase: any,
  fromEmail: string,
  subject: string,
  body: string,
): Promise<{ customerName: string | null; confidence: 'high' | 'medium' | 'low'; method: string }> {
  const normalizedEmail = fromEmail.trim().toLowerCase();
  const domain = normalizedEmail.split('@')[1];
  if (!domain) return { customerName: null, confidence: 'low', method: 'no_domain' };

  // 跳过内部邮件
  if (domain === 'qimoclothing.com') return { customerName: null, confidence: 'high', method: 'internal' };

  // 0. 业务手动补充的精确邮箱列表（最高优先级，绕过所有模糊匹配）
  // customers.contact_emails text[] 由业务在「订单详情 → 邮件中心 → 客户联系邮箱」填写
  // 同一域名下多个客户的场景（如 gmail.com 通用邮箱）必须靠这个精确匹配区分
  try {
    const { data: contactMatch } = await supabase
      .from('customers')
      .select('customer_name')
      .contains('contact_emails', [normalizedEmail])
      .limit(1)
      .maybeSingle();

    if (contactMatch?.customer_name) {
      return {
        customerName: contactMatch.customer_name,
        confidence: 'high',
        method: 'contact_email_exact',
      };
    }
  } catch (err: any) {
    // contact_emails 列还没迁移时静默回退
    if (err?.code !== '42703') {
      console.error('[identifyCustomerFromEmail] contact_emails query error:', err?.message);
    }
  }

  // 1. 查已建立的域名映射（最快）
  const { data: mapping } = await supabase
    .from('customer_email_domains')
    .select('customer_name')
    .eq('email_domain', domain)
    .limit(1)
    .maybeSingle();

  if (mapping?.customer_name) {
    return { customerName: mapping.customer_name, confidence: 'high', method: 'domain_mapping' };
  }

  // 2. 查历史邮件中同域名已关联的客户
  const { data: historicalMatch } = await supabase
    .from('mail_inbox')
    .select('customer_id')
    .ilike('from_email', `%@${domain}`)
    .not('customer_id', 'is', null)
    .limit(1)
    .maybeSingle();

  if (historicalMatch?.customer_id) {
    // 自动建立映射
    try {
      await supabase.from('customer_email_domains').upsert({
        customer_name: historicalMatch.customer_id,
        email_domain: domain,
        sample_email: fromEmail,
      }, { onConflict: 'customer_name,email_domain' });
    } catch {}
    return { customerName: historicalMatch.customer_id, confidence: 'high', method: 'historical_match' };
  }

  // 3. 用客户名模糊匹配域名（如 domain=ragwear.com → customer=rag）
  const { data: customers } = await supabase
    .from('orders')
    .select('customer_name')
    .limit(200);
  const uniqueCustomers = [...new Set((customers || []).map((c: any) => c.customer_name).filter(Boolean))];

  // 客户名长度≥3才用模糊匹配，否则容易误报（如"AP"匹配到"app"、"apparel"）
  // 优先匹配最长的客户名（更精确）
  const sortedCustomers = uniqueCustomers
    .filter((n: any) => typeof n === 'string' && n.length >= 3)
    .sort((a: any, b: any) => b.length - a.length);

  const domainPrefix = domain.split('.')[0];
  for (const name of sortedCustomers) {
    const nameLower = (name as string).toLowerCase().replace(/\s+/g, '');
    // 严格匹配：客户名必须是域名前缀的子串（如 "rag" in "ragapparel"），
    // 而不是整个域名（避免 "ap" 匹配 "supabase.io"）
    if (domainPrefix.includes(nameLower) || nameLower.includes(domainPrefix)) {
      try {
        await supabase.from('customer_email_domains').upsert({
          customer_name: name, email_domain: domain, sample_email: fromEmail,
        }, { onConflict: 'customer_name,email_domain' });
      } catch {}
      return { customerName: name as string, confidence: 'medium', method: 'name_domain_match' };
    }
  }

  // 4. AI 识别（最后手段，用于新客户）
  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic();
    const prompt = `从以下邮件中识别客户名称。已知客户列表：${uniqueCustomers.join('、')}\n\n发件人：${fromEmail}\n主题：${subject}\n正文：${body.slice(0, 500)}\n\n返回JSON：{"customerName":"识别到的客户名或null","isNewCustomer":true/false}\n只返回JSON。`;
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514', max_tokens: 100,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (parsed.customerName) {
        try {
          await supabase.from('customer_email_domains').upsert({
            customer_name: parsed.customerName, email_domain: domain, sample_email: fromEmail,
          }, { onConflict: 'customer_name,email_domain' });
        } catch {}
        return { customerName: parsed.customerName, confidence: 'medium', method: 'ai_match' };
      }
    }
  } catch {}

  return { customerName: null, confidence: 'low', method: 'unmatched' };
}

/**
 * 从初始订单数据自动建立客户-邮箱映射
 * 在系统启动时运行一次
 */
export async function buildInitialMappings(supabase: any): Promise<number> {
  // 从已关联的邮件中提取映射
  const { data: linkedEmails } = await supabase
    .from('mail_inbox')
    .select('from_email, customer_id')
    .not('customer_id', 'is', null)
    .limit(500);

  let created = 0;
  const seen = new Set<string>();

  for (const email of linkedEmails || []) {
    const domain = email.from_email?.split('@')[1]?.toLowerCase();
    if (!domain || domain === 'qimoclothing.com') continue;
    const key = `${email.customer_id}:${domain}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const { error } = await supabase.from('customer_email_domains').upsert({
      customer_name: email.customer_id,
      email_domain: domain,
      sample_email: email.from_email,
    }, { onConflict: 'customer_name,email_domain' });
    if (!error) created++;
  }

  return created;
}
