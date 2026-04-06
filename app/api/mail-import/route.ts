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

export async function POST(req: Request) {
  try {
    const authHeader = req.headers.get('authorization');
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) return NextResponse.json({ error: 'Missing config' }, { status: 500 });

    const supabase = createClient(url, serviceKey);

    // 支持两种方式：POST body 传凭证，或用环境变量
    let body: { email?: string; password?: string; days?: number; max?: number } = {};
    try { body = await req.json(); } catch {}

    const imapUser = body.email || process.env.IMAP_USER;
    const imapPass = body.password || process.env.IMAP_PASSWORD;
    const days = Math.min(body.days || 90, 180);
    const maxEmails = Math.min(body.max || 500, 1000);

    if (!imapUser || !imapPass) {
      return NextResponse.json({ error: '请提供邮箱地址和密码' }, { status: 400 });
    }

    console.log(`[mail-import] 开始导入 ${imapUser} 最近 ${days} 天的邮件`);

    const emails = await fetchNewEmails(maxEmails, days, { user: imapUser, pass: imapPass });

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

    return NextResponse.json({
      success: true,
      message: `${imapUser} 导入完成：拉取${emails.length}封，入库${inserted}封，跳过${skipped}封`,
      account: imapUser,
      fetched: emails.length,
      inserted,
      skipped,
    });
  } catch (err: any) {
    console.error('[mail-import]', err?.message);
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}
