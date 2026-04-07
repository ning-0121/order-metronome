/**
 * 邮件历史导入 API
 *
 * POST /api/mail-import
 * Body: { email: "lucy@qimoclothing.com", password: "xxx", days: 90 }
 * Header: Authorization: Bearer <CRON_SECRET>
 *
 * 连接指定邮箱的 IMAP，拉取历史邮件写入 mail_inbox
 */

import { createClient } from '@supabase/supabase-js';
import { fetchNewEmails } from '@/lib/utils/imap-fetch';
import { NextResponse } from 'next/server';

export const maxDuration = 60;

export async function GET(req: Request) {
  // GET 用于浏览器一键触发，使用 cookie 或 cron secret
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const cookies = req.headers.get('cookie') || '';
  if (cronSecret && authHeader !== `Bearer ${cronSecret}` && !cookies.includes('sb-')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return handleImport(req);
}

export async function POST(req: Request) {
  try {
    const authHeader = req.headers.get('authorization');
    const cronSecret = process.env.CRON_SECRET;
    const cookies = req.headers.get('cookie') || '';
    if (cronSecret && authHeader !== `Bearer ${cronSecret}` && !cookies.includes('sb-')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return handleImport(req);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}

async function handleImport(req: Request) {
  try {

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) return NextResponse.json({ error: 'Missing config' }, { status: 500 });

    const supabase = createClient(url, serviceKey);

    // 安全：密码永远从环境变量读取，严禁通过 URL 参数 / body 传输明文密码
    let body: { email?: string; days?: number; max?: number; skip?: number } = {};
    if (req.method === 'POST') {
      try {
        const raw = await req.json();
        body = {
          email: raw.email,
          days: raw.days,
          max: raw.max,
          skip: raw.skip,
          // 不再接受 raw.password — 会被忽略
        };
      } catch {}
    } else {
      const params = new URL(req.url).searchParams;
      body = {
        email: params.get('email') || undefined,
        days: params.get('days') ? parseInt(params.get('days')!) : undefined,
        max: params.get('max') ? parseInt(params.get('max')!) : undefined,
        skip: params.get('skip') ? parseInt(params.get('skip')!) : undefined,
      };
    }

    const imapUser = body.email || process.env.IMAP_USER;
    const imapPass = process.env.IMAP_PASSWORD; // 仅从环境变量读
    const days = Math.min(body.days || 90, 365);
    const maxEmails = Math.min(body.max || 20, 50); // 默认20，最多50
    const skipFromEnd = body.skip || 0;

    if (!imapUser || !imapPass) {
      return NextResponse.json({ error: '请提供邮箱地址和密码' }, { status: 400 });
    }

    console.log(`[mail-import] 开始导入 ${imapUser} 最近 ${days} 天的邮件 max=${maxEmails} skip=${skipFromEnd}`);

    const emails = await fetchNewEmails(maxEmails, days, { user: imapUser, pass: imapPass }, skipFromEnd);

    if (emails.length === 0) {
      return NextResponse.json({
        success: true,
        message: `${imapUser} 最近 ${days} 天没有找到邮件`,
        fetched: 0, inserted: 0, skipped: 0,
      });
    }

    let inserted = 0;
    let skipped = 0;

    for (const email of emails) {
      const fromEmail = email.from.includes('<')
        ? email.from.match(/<(.+?)>/)?.[1] || email.from
        : email.from;

      const emailDate = email.date?.slice(0, 10) || new Date().toISOString().slice(0, 10);
      const { data: existing } = await supabase
        .from('mail_inbox')
        .select('id')
        .eq('from_email', fromEmail)
        .eq('subject', email.subject)
        .gte('received_at', `${emailDate}T00:00:00`)
        .lte('received_at', `${emailDate}T23:59:59`)
        .limit(1)
        .maybeSingle();

      if (existing) { skipped++; continue; }

      const threadSubject = email.subject
        .replace(/^(re|fwd|fw|回复|转发)\s*[:：]\s*/gi, '')
        .replace(/^(re|fwd|fw)\s*\[\d+\]\s*[:：]?\s*/gi, '')
        .trim();
      const threadId = threadSubject.toLowerCase().replace(/\s+/g, '_').slice(0, 100);

      const { error } = await supabase.from('mail_inbox').insert({
        from_email: fromEmail,
        subject: email.subject,
        raw_body: email.body,
        received_at: email.date || new Date().toISOString(),
        message_id: email.messageId,
        in_reply_to: email.inReplyTo,
        thread_id: threadId,
      });

      if (!error) inserted++;
    }

    const nextSkip = skipFromEnd + emails.length;
    return NextResponse.json({
      success: true,
      message: `${imapUser} 导入完成：拉取${emails.length}封，入库${inserted}封，跳过${skipped}封`,
      account: imapUser,
      fetched: emails.length,
      inserted,
      skipped,
      nextPage: emails.length === maxEmails
        ? `继续下一批: /api/mail-import?days=${days}&max=${maxEmails}&skip=${nextSkip}`
        : '已到末尾',
    });
  } catch (err: any) {
    console.error('[mail-import]', err?.message);
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}
