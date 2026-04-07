/**
 * 邮件系统测试端点 — 测试客户识别和订单匹配
 * GET /api/mail-test?email=morris@ragapparel.net
 */

import { createClient } from '@supabase/supabase-js';
import { identifyCustomerFromEmail } from '@/lib/agent/customerEmailMapping';
import { NextResponse } from 'next/server';

export const maxDuration = 30;

export async function GET(req: Request) {
  try {
    // 安全：仅允许配置了 CRON_SECRET 的受信调用（或 admin 会话）
    const authHeader = req.headers.get('authorization');
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) return NextResponse.json({ error: 'Missing config' });

    const supabase = createClient(url, serviceKey);
    const { searchParams } = new URL(req.url);
    const testEmail = searchParams.get('email') || 'morris@ragapparel.net';

    const results: Record<string, any> = { testEmail };

    // 1. 测试 identifyCustomerFromEmail
    const idResult = await identifyCustomerFromEmail(supabase, testEmail, 'Re: 531 CAPRIS', 'test body');
    results.identification = idResult;

    // 2. 直接测试模糊匹配
    const domain = testEmail.split('@')[1]?.toLowerCase() || '';
    results.domain = domain;
    results.domainPrefix = domain.split('.')[0];

    const { data: customers } = await supabase.from('orders').select('customer_name').limit(200);
    const uniqueCustomers = [...new Set((customers || []).map((c: any) => c.customer_name).filter(Boolean))];
    results.totalCustomers = uniqueCustomers.length;
    results.customerSample = uniqueCustomers.slice(0, 20);

    // 3. 手动测试匹配每个客户
    const matches: any[] = [];
    for (const name of uniqueCustomers) {
      const nameLower = (name as string).toLowerCase().replace(/\s+/g, '');
      const includesNameInDomain = domain.includes(nameLower);
      const includesPrefixInName = nameLower.includes(domain.split('.')[0]);
      if (includesNameInDomain || includesPrefixInName) {
        matches.push({ name, nameLower, includesNameInDomain, includesPrefixInName });
      }
    }
    results.fuzzyMatches = matches;

    // 4. 当前 mail_inbox 状态
    const { count: totalEmails } = await supabase.from('mail_inbox').select('id', { count: 'exact', head: true });
    const { count: identifiedEmails } = await supabase.from('mail_inbox').select('id', { count: 'exact', head: true }).not('customer_id', 'is', null);
    results.mailInboxStats = { total: totalEmails, identified: identifiedEmails };

    return NextResponse.json(results, { status: 200 });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message, stack: err?.stack }, { status: 500 });
  }
}
