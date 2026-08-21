/**
 * 邮件拉取 Cron —— 只做一件事:从 IMAP 把新邮件写进 mail_inbox。
 *
 * 2026-08-21 从 email-scan 拆出来。拆分的原因(Vercel 生产日志实证):
 *   email-scan 24 小时里几乎每次 504。它把「IMAP 拉取」和「AI 深度分析」挤在同一个
 *   60s 函数里,而 IMAP 光超时配置就占 greetTimeout 15s + socketTimeout 30s = 最坏 45s,
 *   再加最多 80 封逐封串行查库去重 —— 预算在上游就烧光了,
 *   下游那道「48s 就 break」的护栏经常在第一封邮件上就触发。
 *   结果:邮件照常入库(每天几十封),但深度分析一封都没推进,积压 38 天。
 *
 * 拆开后两边各自独占 60s,任一边慢都不会饿死另一边。
 * 本路由**不做任何 AI 调用**,不花钱,失败也只影响"新邮件晚一点入库"。
 */

import { createClient } from '@supabase/supabase-js';
import { fetchNewEmails } from '@/lib/utils/imap-fetch';
import { storeMailAttachments } from '@/lib/email/attachments';
import { findExistingMessageIds, existsMailByHeuristic, insertInboundMail } from '@/lib/repositories/mailRepo';
import { NextResponse } from 'next/server';

export const maxDuration = 60;

/** 留给收尾/返回的余量:超过这个点就停止拉取,剩下的下一轮再来(每 15 分钟一次,不会丢)。 */
const FETCH_BUDGET_MS = 45000;

export async function POST(req: Request) {
  const startTime = Date.now();
  try {
    const authHeader = req.headers.get('authorization');
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) return NextResponse.json({ error: 'Missing config' }, { status: 500 });
    const supabase = createClient(url, serviceKey);

    const imapUser = process.env.IMAP_USER;
    const imapPass = process.env.IMAP_PASSWORD;
    if (!imapUser || !imapPass) {
      console.warn('[email-fetch] IMAP_USER/IMAP_PASSWORD 未配置');
      return NextResponse.json({ success: true, fetched: 0, imapStatus: 'no_credentials' });
    }

    let fetched = 0, skippedExisting = 0, stoppedEarly = false;
    let imapStatus = 'skipped';
    let imapError = '';

    try {
      console.log(`[email-fetch] IMAP 连接 ${imapUser}...`);
      // 最近 3 天 / 最多 80 封(防高峰日漏邮件)
      const newEmails = await fetchNewEmails(80, 3);
      imapStatus = `fetched_${newEmails.length}`;
      console.log(`[email-fetch] IMAP 拉取到 ${newEmails.length} 封`);

      // 批量去重:一次查库拿到已存在的 message_id,替代"每封一次 select"。
      // 原来 80 封 × 串行往返是超时主因之一。
      const withMsgId = newEmails.filter((e) => e.messageId).map((e) => e.messageId as string);
      const existingIds = await findExistingMessageIds(supabase, withMsgId);

      for (const email of newEmails) {
        if (Date.now() - startTime > FETCH_BUDGET_MS) {
          stoppedEarly = true;
          console.log('[email-fetch] 接近预算上限,剩余邮件下一轮拉取');
          break;
        }
        const rawFrom = email.from || '';
        const fromEmail = rawFrom.includes('<') ? (rawFrom.match(/<(.+?)>/)?.[1] || rawFrom) : rawFrom;
        if (!fromEmail) continue;

        if (email.messageId) {
          if (existingIds.has(email.messageId)) { skippedExisting++; continue; }
        } else {
          // 无 message_id 才回退到 发件人+主题+同一天 的弱启发式(逐封查,但这类邮件极少)
          const emailDate = email.date?.slice(0, 10) || new Date().toISOString().slice(0, 10);
          if (await existsMailByHeuristic(supabase, fromEmail, email.subject, emailDate)) { skippedExisting++; continue; }
        }

        const threadSubject = email.subject
          .replace(/^(re|fwd|fw|回复|转发)\s*[:：]\s*/gi, '')
          .replace(/^(re|fwd|fw)\s*\[\d+\]\s*[:：]?\s*/gi, '')
          .trim();
        const threadId = threadSubject.toLowerCase().replace(/\s+/g, '_').slice(0, 100);

        const inserted = await insertInboundMail(supabase, {
          from_email: fromEmail,
          subject: email.subject,
          raw_body: email.body,
          received_at: email.date || new Date().toISOString(),
          message_id: email.messageId,
          in_reply_to: email.inReplyTo,
          thread_id: threadId,
        });

        if (inserted.error) {
          console.error('[email-fetch] 写入 mail_inbox 失败:', inserted.error);
          continue;
        }
        fetched++;
        // 附件捕获:PDF/图片 → order-docs 桶 + mail_attachments(供后续 Vision OCR)
        if (email.attachments?.length && inserted.id) {
          try { await storeMailAttachments(supabase, inserted.id, email.attachments); }
          catch (e: any) { console.warn('[email-fetch] 附件存储失败(不阻断):', e?.message); }
        }
      }
    } catch (imapErr: any) {
      imapStatus = 'error';
      imapError = imapErr?.message || 'Unknown IMAP error';
      console.error('[email-fetch] IMAP 失败:', imapError);
    }

    return NextResponse.json({
      success: true, fetched, skippedExisting, stoppedEarly,
      imapStatus, imapError: imapError || undefined,
      elapsedMs: Date.now() - startTime,
    });
  } catch (e: any) {
    console.error('[email-fetch] 未捕获异常:', e?.message);
    return NextResponse.json({ error: e?.message || 'error', elapsedMs: Date.now() - startTime }, { status: 500 });
  }
}
