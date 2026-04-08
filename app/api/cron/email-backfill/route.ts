/**
 * 邮件历史回补 Cron — 每天跑一次
 *
 * 目的：实时扫描只看最近 3 天，历史邮件（过去 30 天内漏掉的）靠这个回补。
 *
 * 策略：
 *  - 从 INBOX 末尾开始，分页向前回溯（skipFromEnd=0, 80, 160, ...）
 *  - 每页 80 封，限定 30 天内
 *  - 当某一页 ≥ 70% 的邮件都已经在 mail_inbox 里 → 说明这段已经覆盖到了，停止
 *  - 最多走 8 页（640 封） 或 50 秒超时
 *
 * 去重：沿用 email-scan 的逻辑（from_email + subject + 同一天）
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
    const startTime = Date.now();

    if (!process.env.IMAP_USER || !process.env.IMAP_PASSWORD) {
      return NextResponse.json({ error: 'IMAP credentials not set' }, { status: 500 });
    }

    const PAGE_SIZE = 80;
    const MAX_PAGES = 8;
    const LOOKBACK_DAYS = 30;
    const STOP_WHEN_DUP_RATIO = 0.7; // 一页里 >70% 已入库就停

    let totalFetched = 0;
    let totalInserted = 0;
    let totalDuplicates = 0;
    let pagesScanned = 0;
    let stopReason = 'completed';

    for (let page = 0; page < MAX_PAGES; page++) {
      if (Date.now() - startTime > 50000) {
        stopReason = 'timeout';
        break;
      }

      const skipFromEnd = page * PAGE_SIZE;
      const emails = await fetchNewEmails(PAGE_SIZE, LOOKBACK_DAYS, undefined, skipFromEnd);
      pagesScanned++;

      if (emails.length === 0) {
        stopReason = 'no_more_emails';
        break;
      }

      totalFetched += emails.length;

      let pageInserted = 0;
      let pageDuplicate = 0;

      for (const email of emails) {
        const rawFrom = email.from || '';
        const fromEmail = rawFrom.includes('<') ? rawFrom.match(/<(.+?)>/)?.[1] || rawFrom : rawFrom;
        if (!fromEmail) continue;

        const emailDate = email.date?.slice(0, 10) || new Date().toISOString().slice(0, 10);

        // 去重：同发件人 + 同主题 + 同一天
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
          pageDuplicate++;
          totalDuplicates++;
          continue;
        }

        const threadSubject = email.subject
          .replace(/^(re|fwd|fw|回复|转发)\s*[:：]\s*/gi, '')
          .replace(/^(re|fwd|fw)\s*\[\d+\]\s*[:：]?\s*/gi, '')
          .trim();
        const threadId = threadSubject.toLowerCase().replace(/\s+/g, '_').slice(0, 100);

        const { error: insertErr } = await supabase.from('mail_inbox').insert({
          from_email: fromEmail,
          subject: email.subject,
          raw_body: email.body,
          received_at: email.date || new Date().toISOString(),
          message_id: email.messageId,
          in_reply_to: email.inReplyTo,
          thread_id: threadId,
        });
        if (!insertErr) {
          pageInserted++;
          totalInserted++;
        } else {
          console.error('[email-backfill] 插入失败:', insertErr.message);
        }
      }

      // 判断是否已经覆盖到这段
      const dupRatio = emails.length > 0 ? pageDuplicate / emails.length : 0;
      console.log(
        `[email-backfill] page ${page} skip=${skipFromEnd} fetched=${emails.length} inserted=${pageInserted} dup=${pageDuplicate} dupRatio=${dupRatio.toFixed(2)}`,
      );

      if (dupRatio >= STOP_WHEN_DUP_RATIO) {
        stopReason = 'caught_up';
        break;
      }
    }

    return NextResponse.json({
      success: true,
      pagesScanned,
      totalFetched,
      totalInserted,
      totalDuplicates,
      stopReason,
      tookMs: Date.now() - startTime,
    });
  } catch (err: any) {
    console.error('[email-backfill]', err?.message);
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}

export async function GET(req: Request) {
  return POST(req);
}
