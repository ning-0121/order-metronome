/**
 * 邮件系统诊断 — 检查IMAP连接和邮箱状态
 * GET /api/mail-diagnose
 */

import { NextResponse } from 'next/server';

export const maxDuration = 30;

export async function GET(req: Request) {
  const results: Record<string, any> = {
    timestamp: new Date().toISOString(),
    env: {
      IMAP_HOST: process.env.IMAP_HOST || '未设置',
      IMAP_PORT: process.env.IMAP_PORT || '未设置',
      IMAP_USER: process.env.IMAP_USER || '未设置',
      IMAP_PASSWORD: process.env.IMAP_PASSWORD ? '已设置(****)' : '未设置',
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ? '已设置' : '未设置',
      CRON_SECRET: process.env.CRON_SECRET ? '已设置' : '未设置',
    },
    imap: { status: 'not_tested' },
    mailbox: {},
    recentEmails: [],
    database: { mail_inbox_count: 0 },
  };

  // 1. 测试 IMAP 连接
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASSWORD;
  const host = process.env.IMAP_HOST || 'imap.exmail.qq.com';
  const port = parseInt(process.env.IMAP_PORT || '993');

  if (!user || !pass) {
    results.imap = { status: 'error', message: 'IMAP_USER 或 IMAP_PASSWORD 未配置' };
  } else {
    try {
      const { ImapFlow } = await import('imapflow');

      // 显示密码前4位用于确认（不暴露完整密码）
      results.debug = {
        passwordPrefix: pass.slice(0, 4) + '****',
        passwordLength: pass.length,
      };

      const client = new ImapFlow({
        host, port, secure: true,
        auth: { user, pass },
        logger: {
          debug: () => {},
          info: (msg: any) => { results.imapLog = results.imapLog || []; results.imapLog.push(String(msg?.msg || msg)); },
          warn: (msg: any) => { results.imapLog = results.imapLog || []; results.imapLog.push('WARN:' + String(msg?.msg || msg)); },
          error: (msg: any) => { results.imapLog = results.imapLog || []; results.imapLog.push('ERR:' + String(msg?.msg || msg)); },
        },
        greetTimeout: 10000,
        socketTimeout: 15000,
      } as any);

      await client.connect();
      results.imap = { status: 'connected', host, user };

      // 2. 查看邮箱状态
      const mailbox = await client.status('INBOX', {
        messages: true,
        recent: true,
        unseen: true,
      });
      results.mailbox = {
        total: mailbox.messages,
        recent: mailbox.recent,
        unseen: mailbox.unseen,
      };

      // 3. 如果有邮件，读取最近5封的主题
      if (mailbox.messages && mailbox.messages > 0) {
        const lock = await client.getMailboxLock('INBOX');
        try {
          // 搜索最近7天
          const since = new Date(Date.now() - 7 * 86400000);
          const searchResult = await client.search({ since });
          results.search_7days = { found: searchResult?.length || 0 };

          // 也搜索全部
          const allResult = await client.search({ all: true });
          results.search_all = { found: allResult?.length || 0 };

          // 读最近5封
          if (allResult && allResult.length > 0) {
            const last5 = allResult.slice(-5);
            const previews: any[] = [];
            for await (const msg of client.fetch(last5, { envelope: true })) {
              previews.push({
                from: msg.envelope?.from?.[0]?.address || '?',
                subject: msg.envelope?.subject || '(no subject)',
                date: msg.envelope?.date?.toISOString() || '?',
              });
            }
            results.recentEmails = previews;
          }
        } finally {
          lock.release();
        }
      }

      await client.logout();
    } catch (err: any) {
      results.imap = {
        status: 'error',
        message: err?.message || 'Unknown error',
        code: err?.code,
        responseText: err?.responseText || err?.response,
        host, user,
      };
    }
  }

  // 4. 查数据库
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (url && key) {
      const supabase = createClient(url, key);
      const { count } = await supabase.from('mail_inbox').select('id', { count: 'exact', head: true });
      results.database.mail_inbox_count = count || 0;

      // 最近5条记录
      const { data: recent } = await supabase.from('mail_inbox')
        .select('from_email, subject, received_at')
        .order('received_at', { ascending: false })
        .limit(5);
      results.database.recent = recent || [];
    }
  } catch {}

  return NextResponse.json(results, { status: 200 });
}
