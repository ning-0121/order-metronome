/**
 * 邮件历史导入 API — 一次性拉取历史邮件
 *
 * POST /api/mail-import?days=90
 * Header: Authorization: Bearer <CRON_SECRET>
 *
 * 从 IMAP 拉取指定天数内的邮件写入 mail_inbox
 * 用于初始化系统、建立客户画像
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

    // 从 URL 参数获取回溯天数，默认90天
    const { searchParams } = new URL(req.url);
    const days = Math.min(parseInt(searchParams.get('days') || '90'), 180);
    const maxEmails = Math.min(parseInt(searchParams.get('max') || '500'), 1000);

    console.log(`[mail-import] 开始导入最近 ${days} 天的邮件，最多 ${maxEmails} 封`);

    // 拉取邮件
    const emails = await fetchNewEmails(maxEmails, days);

    if (emails.length === 0) {
      return NextResponse.json({
        success: true,
        message: '未找到邮件，请确认 IMAP 配置正确且邮箱中有邮件',
        fetched: 0,
        inserted: 0,
        skipped: 0,
      });
    }

    let inserted = 0;
    let skipped = 0;

    for (const email of emails) {
      const fromEmail = email.from.includes('<')
        ? email.from.match(/<(.+?)>/)?.[1] || email.from
        : email.from;

      // 去重
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

      if (existing) {
        skipped++;
        continue;
      }

      // 生成 thread_id
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
      message: `导入完成：${inserted} 封入库，${skipped} 封跳过（已存在）`,
      fetched: emails.length,
      inserted,
      skipped,
    });
  } catch (err: any) {
    console.error('[mail-import]', err?.message);
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}

export async function GET(req: Request) { return POST(req); }
