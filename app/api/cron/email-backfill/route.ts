/**
 * 邮件历史回补 Cron — 每天跑一次
 *
 * 策略：
 *  - 每次从 INBOX 末尾向前推进 50 封（通过 skipFromEnd 分页）
 *  - 进度持久化到 system_kv 表（key='email_backfill_offset'）
 *  - 回溯 365 天，直到某页全部邮件都超过 365 天或已经到头 → 标记完成
 *  - 完成后不再拉取（每天检查一次 offset 状态即可）
 *
 * 去重：同发件人 + 同主题 + 同一天
 */

import { createClient } from '@supabase/supabase-js';
import { fetchNewEmails } from '@/lib/utils/imap-fetch';
import { NextResponse } from 'next/server';

export const maxDuration = 60;

const BATCH_SIZE = 50; // 每天拉 50 封
const LOOKBACK_DAYS = 365; // 回溯一年

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

    if (!process.env.IMAP_USER || !process.env.IMAP_PASSWORD) {
      return NextResponse.json({ error: 'IMAP credentials not set' }, { status: 500 });
    }

    // 读取进度
    const { data: kvRow } = await supabase
      .from('system_kv')
      .select('value')
      .eq('key', 'email_backfill_offset')
      .maybeSingle();

    const state = kvRow?.value ? (typeof kvRow.value === 'string' ? JSON.parse(kvRow.value) : kvRow.value) : null;

    // 已完成则跳过
    if (state?.completed) {
      return NextResponse.json({
        success: true,
        message: '历史回补已完成',
        completedAt: state.completedAt,
        totalInserted: state.totalInserted,
      });
    }

    const currentOffset = state?.offset || 0;
    const totalInsertedSoFar = state?.totalInserted || 0;

    // 拉取一批邮件
    const emails = await fetchNewEmails(BATCH_SIZE, LOOKBACK_DAYS, undefined, currentOffset);

    if (emails.length === 0) {
      // 没有更多邮件了 — 标记完成
      await saveProgress(supabase, currentOffset, totalInsertedSoFar, true);
      return NextResponse.json({
        success: true,
        message: '历史回补完成 — 已到达邮箱头部',
        offset: currentOffset,
        totalInserted: totalInsertedSoFar,
      });
    }

    let inserted = 0;
    let duplicates = 0;

    for (const email of emails) {
      const rawFrom = email.from || '';
      const fromEmail = rawFrom.includes('<') ? rawFrom.match(/<(.+?)>/)?.[1] || rawFrom : rawFrom;
      if (!fromEmail) continue;

      const emailDate = email.date?.slice(0, 10) || new Date().toISOString().slice(0, 10);

      // 去重
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
        duplicates++;
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
        inserted++;
      } else {
        console.error('[email-backfill] 插入失败:', insertErr.message);
      }
    }

    const newOffset = currentOffset + BATCH_SIZE;
    const newTotal = totalInsertedSoFar + inserted;

    // 如果本批全部重复 → 可能已经覆盖到，但继续推进（直到没有邮件为止）
    await saveProgress(supabase, newOffset, newTotal, false);

    console.log(
      `[email-backfill] offset=${currentOffset}→${newOffset} fetched=${emails.length} inserted=${inserted} dup=${duplicates} totalInserted=${newTotal}`,
    );

    return NextResponse.json({
      success: true,
      offset: newOffset,
      fetched: emails.length,
      inserted,
      duplicates,
      totalInserted: newTotal,
    });
  } catch (err: any) {
    console.error('[email-backfill]', err?.message);
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}

async function saveProgress(
  supabase: any,
  offset: number,
  totalInserted: number,
  completed: boolean,
) {
  const value = JSON.stringify({
    offset,
    totalInserted,
    completed,
    completedAt: completed ? new Date().toISOString() : null,
    updatedAt: new Date().toISOString(),
  });

  await supabase
    .from('system_kv')
    .upsert({ key: 'email_backfill_offset', value }, { onConflict: 'key' });
}

export async function GET(req: Request) {
  return POST(req);
}
